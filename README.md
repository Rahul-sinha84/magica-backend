# Magica backend

The API behind the Magica work trial: an Express + TypeScript service that owns authentication, chats and messages, the credit ledger, and agent turns. A turn runs as a Trigger.dev task that streams an answer from the OpenRouter free router to the browser and to the database as it is written.

The frontend lives in [`../magica-frontend`](https://github.com/Rahul-sinha84/magica-frontend). The build plan and every decision are tracked in [issue #1](https://github.com/Rahul-sinha84/magica-backend/issues/1).

**Stack:** Node 22+ (developed on 26), pnpm 11, TypeScript (strict, ESM), Express 5, PostgreSQL 16 + Prisma 7 (driver adapter), Clerk, Trigger.dev v4, OpenRouter (`openrouter/free` only), Zod 4, pino, Vitest.

## Getting started

Prerequisites: Node 22.12+, pnpm 11, Docker, and accounts for Clerk, Trigger.dev and OpenRouter.

```bash
pnpm install                  # also generates the Prisma client
cp .env.example .env.local    # then fill in the keys (see below)
pnpm db:up                    # Postgres in Docker, with magica_dev and magica_test
pnpm db:deploy                # apply the migrations to magica_dev
pnpm dev                      # API on http://localhost:3000
pnpm trigger:dev              # in a second terminal: the agent worker (log in to Trigger.dev on first run)
```

Then check it:

```bash
curl localhost:3000/api/health
TEST_TOKEN=<token> ./scripts/smoke.sh    # token from the frontend console: await window.Clerk.session.getToken()
```

### Environment

Everything lives in `.env.local`. `.env.example` lists each variable with a comment. Every value is validated at startup, and a bad one stops the process with a readable message. The API and the worker each validate only what they need.

| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | both | Postgres URL. |
| `DATABASE_POOL_MAX` | both | Connections per process (default 10). See [Many turns at once](#many-turns-at-once). |
| `OPENROUTER_MODEL` | both | Must be `openrouter/free`; anything else, including paid routers, is refused at boot. |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | API | Same Clerk instance as the frontend. |
| `FRONTEND_ORIGIN` | API | Exact browser origin (CORS and Clerk `authorizedParties`); default `http://localhost:3001`. |
| `TRIGGER_SECRET_KEY` | API | Starts, cancels and looks up runs, and creates the browser's read-only realtime tokens. |
| `TRUST_PROXY` | API | Number of reverse proxies in front (0 locally, 1 on Railway and similar), so rate limits see the real client IP. |
| `CREDIT_STARTING_BALANCE`, `CREDIT_ADMISSION_HOLD` | API | 30,000,000 and 100,000 by default. |
| `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` | worker | |
| `AGENT_CONCURRENCY_LIMIT` | worker | Turns that run at once (default 20); the rest wait in the queue. Read when the task is indexed, so set it in the Trigger.dev environment too. |
| `TRIGGER_PROJECT_REF` | `trigger.config.ts` only | |
| `TEST_DATABASE_URL` | tests | Defaults to `magica_test` on the local container. |

Clerk prints a telemetry notice with development keys; set `CLERK_TELEMETRY_DISABLED=1` to turn it off.

### Scripts

| Script | What it does |
|---|---|
| `pnpm dev` / `pnpm start` | API with reload / the built API (`pnpm build` first). |
| `pnpm trigger:dev` | The Trigger.dev dev worker, reading `.env.local`. |
| `pnpm trigger:deploy` | Deploys the worker to Trigger.dev production (see [Deploying](#deploying)). |
| `pnpm skills:check` | Checks `agent-skills/` exactly as the worker loads it. |
| `pnpm magica:try` | Runs each Magica tool once against the real API (uses credits). |
| `pnpm test:run`, `test:unit`, `test:integration` | All tests / one project. Integration tests need `pnpm db:up`. |
| `pnpm typecheck`, `pnpm lint` | |
| `pnpm db:up`, `db:down`, `db:reset` | Local Postgres (`db:reset` deletes the data). `POSTGRES_PORT` changes the port if 5432 is taken. |
| `pnpm db:migrate`, `db:deploy`, `db:studio`, `db:generate` | Prisma. |
| `pnpm contracts:sync` | Copies `src/contracts` into the frontend with a sha256 lock (see [Contracts](#contracts)). |
| `pnpm smoke` | `scripts/smoke.sh` against a running API (needs `curl`, `jq` and `TEST_TOKEN`). |

The start scripts pass `--no-experimental-webstorage`: Node 25+ otherwise prints a `localStorage` warning on every start.

## Architecture

```
browser ──Bearer token──▶ Express API ──▶ Postgres
   │                          │ start / cancel / look up runs
   │ realtime (read-only      ▼
   │  token, one run)    Trigger.dev ──▶ agent-turn worker ──▶ OpenRouter (openrouter/free)
   └──────────────────────────┘                  │
                                                 └──▶ Postgres (partial reply, final state)
```

```
src/
  app.ts, server.ts      Express app and process lifecycle (graceful shutdown)
  env/                   Zod env schemas: base (both), server (API), worker
  contracts/             Zod schemas shared with the frontend (the source of truth)
  auth/                  Clerk verification and lazy user provisioning
  middleware/            request context, validation, CORS, rate limits, errors
  routes/                health, credits, chats, messages, runs
  services/              turns (send), runs (finalizeRun), reconcile (stale runs), credits, serialize
  agent/                 the turn core (runTurn), context window, prompt, outcomes
  trigger/agentTurn.ts   the Trigger.dev task (a thin wrapper around agent/runTurn)
  lib/                   logger, errors, cursor, openrouter client, trigger client, text helpers
prisma/                  schema and migrations
scripts/                 contracts sync, smoke test
tests/                   unit and integration (real Postgres; Clerk and Trigger.dev mocked)
```

### Data model

- **User** (Clerk id): `balance` and `held` credits. `email` is informational only (not unique, may be null).
- **Chat**: `title`, `isPinned`, `lastMessageAt`, indexed for the sidebar order.
- **Message**: `role`, `status` (`STREAMING`, `COMPLETED`, `FAILED`, `CANCELLED`), `content` (plain text) and `contentBlocks` (JSONB, validated with Zod), and `clientMessageId` (unique per chat).
- **AgentRun**: links the question to its reply; holds status, `triggerRunId`, the routed model, token counts and a safe error code and message. A partial unique index allows only one `PENDING`/`RUNNING` run per chat.
- **ToolInvocation**: reserved for tools (Day 2).
- **CreditLedger**: every grant, hold and release, with a unique idempotency key. Balances change only in the same transaction as their ledger row, and CHECK constraints keep them from going negative.

### API

All routes except health need `Authorization: Bearer <Clerk session token>`. Errors are `{ "error": "<safe message>", "code": "<CODE>", "details"?: {...} }`. Another user's chat or run is a 404, never a 403, so nothing leaks.

| Route | |
|---|---|
| `GET /api/health` | Checks the database. |
| `GET /api/credits` | `{ balance, held }`. |
| `GET /api/models` | The models the agent uses (only `openrouter/free`) and its recent health: `available`, `degraded`, `unavailable` or `unknown`, judged from turns that ended in the last 15 minutes, plus the real model the router used last. Cached for 30 s per process. |
| `GET /api/chats?cursor&limit` | Pinned first, then most recent activity. |
| `POST /api/chats` | Creates "New chat". |
| `GET`, `PATCH`, `DELETE /api/chats/:chatId` | `PATCH` takes `title` and/or `isPinned`. `DELETE` also ends an active run. |
| `GET /api/chats/:chatId/messages?cursor&limit` | Newest page first; each page is oldest to newest. `errorMessage` is set on failed replies. |
| `POST /api/chats/:chatId/messages` | Sends a message and starts a turn: `{ content, clientMessageId }`. |
| `GET /api/chats/:chatId/active-run` | The run in flight, a fresh realtime token, and the partial reply saved so far. |
| `POST /api/runs/:runId/cancel` | 204, or 404 when there is nothing left to stop. |
| `POST /api/runs/:runId/retry` | Answers the same question again as a new turn (201, or 200 for a repeated request). Only the chat's latest turn, and only if it failed or was stopped (409 `RUN_NOT_RETRYABLE` otherwise); the failed reply stays visible. Messages carry `canRetry` on the one reply this applies to. Shares the send rate limit. |

### A turn, end to end

1. **Send.** One transaction places the credit hold, then writes the user message, a `STREAMING` reply placeholder and a `PENDING` run. On a first message it also names the chat from the message (first 50 characters). A second active run in the chat is 409 `RUN_ACTIVE`, and too little credit is 402.
2. **Dispatch.** After the commit, the API starts the `agent-turn` task, using the run id as Trigger.dev's idempotency key. If that fails, the send is undone and the answer is 503, which means nothing happened. On success the answer is 201 with the ids and a read-only realtime token for this one run (valid for an hour).
3. **Run.** The worker claims the run (`PENDING` → `RUNNING`) and reads the conversation. It streams the model's answer as chunks on the Trigger.dev stream `chunks` and saves the partial reply about once a second. Saves only touch a reply that is still `STREAMING`, so a late save can never overwrite a reply that ended elsewhere.
4. **End.** Every ending goes through `finalizeRun`, a compare-and-set that runs once per run. It writes the final reply and status, releases the hold, and records the model and tokens. The worker ends the run itself; the task's failure and cancel hooks cover crashes and time-outs, and cancel, chat delete and stale-run recovery use the same function.

While it runs, the run's metadata follows the required status model: `thinking` → `working` (writing, or using a tool, shown by `currentTool`) → `complete`, `failed` or `cancelled`, with `stopping` while a cancel is carried out.

The browser follows a run live through Trigger.dev realtime. The database is the source of truth, so `active-run` can always rebuild the screen (after a reload, or if realtime drops).

## Design decisions and trade-offs

- **Express instead of Next.js route handlers.** The brief suggests Next route handlers; a separate API keeps the long-lived pieces (Trigger.dev client, database pool, rate limits) out of the frontend's serverless functions and lets both repos deploy on their own.
- **One active run per chat, enforced by the database** (a partial unique index), not by a check-then-insert that two requests could both pass.
- **Retry answers the same question again, only for the latest turn.** It creates a new run and reply for the existing question, with the same rules as a send (credit hold, one run per chat, undone if the agent can't start). The chat row is locked while checking "is this still the latest turn?", so a send and a retry can't both win. A unique `retryOfRunId` makes a double click return the same retry.
- **Idempotent send.** The client picks `clientMessageId`. Sending it again returns the same turn with 200; the same id with different text is a 400; a retry after a failed run needs a new id.
- **Credits are held at send and released at the end.** Each turn costs 0 credits for now, because the free router has no price; the hold only admits a turn. Credits held by a run that died are reclaimed when a send would otherwise be refused for lack of credit.
- **Stale runs recover themselves, but waiting is not stale.** A run that was never dispatched is ended after 60 s. A run waiting in Trigger.dev's queue is left alone however busy it is; each run is dispatched with a 10-minute queue TTL, after which Trigger.dev drops it as `EXPIRED` and we end it with a safe message (and end it ourselves at 11 minutes if Trigger.dev can't be asked). Only a run no worker can ever take (Trigger.dev reports `PENDING_VERSION`: the task isn't deployed) is ended after 3 minutes, and its queue entry is cancelled. A run with no saved progress for 30 s is checked with Trigger.dev, at most every 15 s. A started run never lives past 11 minutes counted from when it started (the task's 10-minute limit plus slack), so time spent in the queue doesn't count. This happens on demand, when `active-run` is read or a send finds the chat busy (or the user short of credit), so there is no background job to run or monitor.
- **The model is retried only before the first output** (3 attempts, jittered backoff, Retry-After honoured). Once text has streamed, a retry would rewrite what the user is reading, so the turn fails and keeps the partial reply. Trigger.dev never retries a turn, for the same reason.
- **Safe errors.** Every failure becomes a fixed code and message (for example `MODEL_RATE_LIMITED`, `AGENT_TIMEOUT`); provider text, keys and stack traces never reach a client.
- **Context window:** the newest finished messages up to the question, at most 100 messages or 48,000 characters. Failed and cancelled replies are left out, so a retry sees what the first attempt saw.
- **Auth is Bearer-only.** Cookies are ignored, so there is no CSRF surface. A bad or missing token is 401; Clerk itself being unreachable is 503, so the frontend doesn't sign the user out over an outage. Users are created on first sight (with their Clerk email and starting grant, in one transaction); a small in-process cache skips repeat database hits.
- **Rate limits are in memory, per process:** 300 requests a minute per user (60 per IP when signed out) and 10 sends a minute. With several instances each has its own counters, so a shared store (Redis) is the next step for a real deployment.
- **Timeouts everywhere:** 8 s to verify a sign-in with Clerk, 5 s to get a database connection, 15 s per statement, 8 s for each Trigger.dev call, a stall timeout on the model stream, and 10 s for in-flight requests on shutdown.
- **Logs:** pino, JSON in production and pretty in development. Every line carries `processId`; every request gets a trace id (an incoming `x-trace-id` is honoured if it looks safe). The trace id travels in the task payload, so the API's and the worker's lines for one turn share it, along with `chatId`, `runId` and `messageId`.
- **Chat lists are keyset-paginated.** A chat pinned or unpinned during a walk can appear on two pages, so clients de-duplicate by id.
- **Imports:** `#src/*` (Node subpath imports). The custom `magica-source` condition points them at the TypeScript sources for tsx, tsc, Vitest and the Trigger.dev bundler, and at `dist/` for `pnpm start`.

## Many turns at once

The send path only writes a few rows and hands the turn to Trigger.dev, so accepting 1,000 turns at once is cheap. How many *run* at once is set by three limits:

1. **`AGENT_CONCURRENCY_LIMIT`** (default 20): the agent task's queue. Turns above it wait, durably, and are shown to the client as a `PENDING` run. Nothing fails for waiting.
2. **Your Trigger.dev plan's concurrency** for the environment; set it at or above the queue limit.
3. **OpenRouter's free rate limits**, the real ceiling, which no setting removes. Raising the queue limit past what the free route allows only turns waiting into 429s (which the turn reports with a safe message), so the queue limit is deliberately a throttle.

So at 1,000 concurrent turns every turn is accepted, holds its credits, and runs as capacity allows, in order; none is duplicated, lost or charged twice, and each ends exactly once.

The database needs one setting for this: every Trigger.dev run is its own process with its own pool, so point the worker at a pooled URL (PgBouncer, or Neon's pooled connection string) and set `DATABASE_POOL_MAX=1` or `2` there. Partial-reply saves are about one small update per second per running turn.

## Contracts

`src/contracts/` holds the Zod schemas and helpers (such as `foldChunks`) that both repos use. The backend is the source of truth: `pnpm contracts:sync` copies the files into `../magica-frontend/contracts/` (override with `FRONTEND_REPO_PATH`) and writes `contracts.lock.json` with a sha256 per file. The frontend only verifies with `pnpm contracts:check` and never edits the copies.

## Database migrations

- **Forward:** create with `pnpm db:migrate` (development), apply with `pnpm db:deploy` (every other environment, before starting the new code). Point `DATABASE_URL` at a direct, non-pooled connection for migrations.
- **Rollback:** Prisma has no down migrations. Write a new forward migration that reverses the change, and deploy it. Every migration so far is additive or drops an index only, so the previous code still runs against the new schema.
- The partial unique index on active runs and the CHECK constraints are plain SQL inside the migrations, because Prisma's schema language can't express them. Prisma won't recreate them from `schema.prisma`, so keep them in any migration that rebuilds those tables.

## Testing

- **Unit tests** cover pure code: contracts, the chunk fold, the OpenRouter client against a local fake SSE server, env parsing, cursors, rate limits and so on.
- **Integration tests** run against a real Postgres database (`magica_test`, truncated between tests). Clerk and Trigger.dev are mocked at the module boundary; the agent turn runs with a scripted fake model.
- `tests/integration/smoke.test.ts` runs `scripts/smoke.sh` against the app, so the script is known to work.
- A bundle test checks that the worker never pulls in API-only code (routes, Clerk, Express, the Trigger.dev client).
- HTTP tests bind to `127.0.0.1` explicitly: supertest's default random port on all interfaces sometimes reached other local apps.

Real Clerk verification, real Trigger.dev and real OpenRouter traffic are checked by hand (the manual checks in issue #1).

## Deploying

Four services, set up in this order: the database, the worker, the API, then the frontend. Every step uses the
`development` branch.

### 1. Database (Neon)
Create a Neon project (in the region you'll run the API in). Neon gives two connection strings:
- the **pooled** one (host contains `-pooler`): the app uses it as `DATABASE_URL`;
- the **direct** one: migrations use it as `DIRECT_URL`, because migrations must bypass the pooler.

Our client sends a 15 s statement timeout when it connects. If the pooler rejects that ("unsupported startup
parameter"), set `DATABASE_STATEMENT_TIMEOUT_MS=0` and put the limit on the database role instead, which works
through any pooler: `ALTER ROLE <your role> SET statement_timeout = '15s';`

### 2. Worker (Trigger.dev production)
In the Trigger.dev dashboard, open the **Production** environment's variables and set:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon's pooled URL |
| `DATABASE_POOL_MAX` | `2` (every run is its own process; the pooler multiplexes them) |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `15000`, or `0` (see above) |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | your key; `openrouter/free` |
| `MAGICA_API_KEY`, `MAGICA_BASE_URL` | your key; `https://inference.magica.com` |
| `AGENT_CONCURRENCY_LIMIT` | `20` |
| `NODE_ENV`, `LOG_LEVEL` | `production`, `info` |

Then deploy from this repo: `pnpm trigger:deploy` (it reads `TRIGGER_PROJECT_REF` from `.env.local`; run
`pnpm exec trigger login` first if needed). The dashboard should then list the `agent-turn` and `magica-tool` tasks.
`pnpm exec trigger deploy --dry-run` builds the same bundle without deploying, to check it first.

### 3. API (Railway)
Create a Railway project from the GitHub repo (`development` branch). `railway.json` sets everything else: build
(`pnpm build`), migrations before each deploy (`pnpm db:deploy`), start (`pnpm start`), and the health check
(`/api/health`). Set the service's variables:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL`, `DIRECT_URL` | Neon's pooled and direct URLs |
| `DATABASE_POOL_MAX` | `10` |
| `DATABASE_STATEMENT_TIMEOUT_MS` | as for the worker |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | the same Clerk instance as the frontend |
| `TRIGGER_SECRET_KEY` | the **production** secret key (`tr_prod_…`), so runs go to the deployed worker |
| `FRONTEND_ORIGIN` | the frontend's URL (set after step 4; until then, anything) |
| `TRUST_PROXY` | `1` (Railway runs one proxy in front) |
| `CREDIT_STARTING_BALANCE`, `CREDIT_ADMISSION_HOLD` | optional; default 30,000,000 and 100,000 |

Railway sets `PORT`. Generate a public domain for the service, then check `https://<domain>/api/health`.

### 4. Frontend (Vercel)
Deploy `../magica-frontend` with `NEXT_PUBLIC_BACKEND_URL` set to the API's URL (plus its Clerk keys, see its README).
Then set the API's `FRONTEND_ORIGIN` to the frontend's production URL, exactly as the browser shows it (no trailing
slash), and redeploy the API. CORS and Clerk's `authorizedParties` both allow only that one origin, so Vercel preview
deployments (other URLs) are refused by design.

### 5. Check it
`TEST_TOKEN=<token from the deployed frontend> BASE_URL=https://<api domain> pnpm smoke`, then a real image turn in the
deployed app.

## What I'd do with more time

- Tools, skills, attachments (Transloadit) and waitpoints (Day 2); the schema and stream format already have room for them.
- A retry endpoint, chat search, and a per-user cap on chats.
- A shared rate-limit store, and per-token credit charging once a paid model is allowed.
- More reliable answers from the free router: it sometimes picks a model that isn't a chat model (for example a content-safety classifier). Retry when the routed model isn't a chat model, or allow a short list of named free models.
- Keep each cancelled or failed question as its own turn in the context, instead of merging consecutive questions.
- Deployment (Railway + Neon) with CI running the suite against a Postgres service.
