# Magica backend

The API and agent worker behind the Magica clone (work trial). An Express + TypeScript API owns sign-in, chats, credits, uploads, API keys and the public API. A Trigger.dev worker runs the agent: it streams answers from the OpenRouter free router, calls the real Magica tools (GPT Image 2, Crop Image, Merge Videos) as durable child tasks, loads skills on demand, pauses for plan and spend approvals, and sends signed webhooks.

- **Frontend:** [`magica-frontend`](https://github.com/Rahul-sinha84/magica-frontend) (Next.js), expected next to this repo as `../magica-frontend`.
- **Build plan and every decision:** [Day 1](https://github.com/Rahul-sinha84/magica-backend/issues/1), [Day 2](https://github.com/Rahul-sinha84/magica-backend/issues/2), [Day 3](https://github.com/Rahul-sinha84/magica-backend/issues/3).
- **Deployed app:** `https://magica-frontend-eight.vercel.app`; API: `https://magica-backend-production.up.railway.app`.
- **Public API docs:** https://personal-f2ba2da4.mintlify.site (Mintlify, built from [`docs/`](docs) on `development`; run them locally with `pnpm docs:dev`).

**Stack:** Node 22.12+ (developed on 26), pnpm 11, TypeScript (strict, ESM), Express 5, PostgreSQL 16 + Prisma 7 (driver adapter), Clerk, Trigger.dev v4, OpenRouter (`openrouter/free` only), the Magica model API, Transloadit, Zod 4, pino, Vitest, Mintlify.

**Contents:** [Getting started](#getting-started) · [Architecture](#architecture) · [Key decisions](#key-decisions) · [Many turns at once](#many-turns-at-once) · [Contracts](#contracts) · [Migrations](#database-migrations) · [Testing](#testing) · [Deploying](#deploying) · [Limitations and more time](#known-limitations) · [Reference issues](#issues-found-in-the-reference)

## Getting started

**Prerequisites:**
- Node 22.12+, pnpm 11 and Docker;
- accounts for Clerk, Trigger.dev and OpenRouter, and a Magica API key;
- Transloadit (for uploads) is optional.

```bash
pnpm install                  # also generates the Prisma client
cp .env.example .env.local    # then fill in the keys (see below)
pnpm db:up                    # Postgres in Docker, with magica_dev and magica_test
pnpm db:deploy                # apply the migrations to magica_dev
pnpm dev                      # API on http://localhost:3000
pnpm trigger:dev              # in a second terminal: the worker (log in to Trigger.dev on first run)
```

Then check it:

```bash
curl localhost:3000/api/health
TEST_TOKEN=<token> pnpm smoke     # token from the frontend's console: await window.Clerk.session.getToken()
```

To try the public API, create a key in the app (sidebar → **API / MCP**), then:

```bash
curl localhost:3000/v1/credits -H "x-api-key: mgc_…"
```

### Environment

Everything lives in `.env.local`; `.env.example` lists each variable with a comment. Every value is validated at startup, and a bad one stops the process with a readable message. The API and the worker each validate only what they need.

| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | both | Postgres URL. |
| `DIRECT_URL` | migrations | A non-pooled URL for `prisma migrate` (falls back to `DATABASE_URL`). |
| `DATABASE_POOL_MAX` | both | Connections per process (default 10). See [Many turns at once](#many-turns-at-once). |
| `DATABASE_STATEMENT_TIMEOUT_MS` | both | Sent on connect (default 15000); `0` behind a pooler that rejects it (see [Deploying](#1-database-neon)). |
| `OPENROUTER_MODEL` | both | Must be `openrouter/free`; anything else, including paid routers, is refused at boot. |
| `WEBHOOK_SECRET_KEY` | both | 64 hex characters (`openssl rand -hex 32`), the **same value** on the API and the worker. It encrypts webhook signing secrets. Without it, webhooks answer "unavailable". |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | API | Same Clerk instance as the frontend. |
| `FRONTEND_ORIGIN` | API | Exact browser origin (CORS for `/api` and Clerk's `authorizedParties`). Default `http://localhost:3001`. |
| `TRIGGER_SECRET_KEY` | API | Starts, cancels and looks up runs, completes waitpoint tokens, and creates the browser's read-only realtime tokens. |
| `TRUST_PROXY` | API | Number of reverse proxies in front (0 locally, 1 on Railway), so rate limits see the real client IP. |
| `CREDIT_STARTING_BALANCE`, `CREDIT_ADMISSION_HOLD` | API | 30,000,000 and 100,000 by default. |
| `TRANSLOADIT_AUTH_KEY`, `TRANSLOADIT_AUTH_SECRET` | API | Optional, both or neither. Without them, uploads answer "unavailable". |
| `PUBLIC_API_URL` | API | Optional: this API's public https address. When set, Transloadit reports finished uploads to it directly. Unset locally. |
| `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` | worker | |
| `MAGICA_API_KEY`, `MAGICA_BASE_URL` | worker | The Magica model API (`https://inference.magica.com`). Only the worker calls it. |
| `AGENT_CONCURRENCY_LIMIT` | worker | Turns that run at once (default 20); the rest wait in the queue. Read when the task is indexed, so set it in the Trigger.dev environment too. |
| `CREDIT_APPROVAL_THRESHOLD` | worker | A step whose paid tool calls are estimated above this asks for approval first (default 600,000: any single image runs without asking). |
| `TRIGGER_PROJECT_REF` | `trigger.config.ts` | |
| `TEST_DATABASE_URL` | tests | Defaults to `magica_test` on the local container. |

Scripts read a few more: `FRONTEND_REPO_PATH` (`contracts:sync`), `OPENAPI_SERVER_URL` (`docs:generate`), `SKILLS_DIR` (`skills:check`) and `POSTGRES_PORT` (`db:up`). Clerk prints a telemetry notice with development keys; `CLERK_TELEMETRY_DISABLED=1` turns it off.

### Scripts

| Script | What it does |
|---|---|
| `pnpm dev` / `pnpm start` | API with reload / the built API (`pnpm build` first). |
| `pnpm trigger:dev` | The Trigger.dev dev worker, reading `.env.local`. |
| `pnpm trigger:deploy` | Deploys the worker to Trigger.dev production (see [Deploying](#deploying)). |
| `pnpm test:run`, `test:unit`, `test:integration` | All tests / one project. Integration tests need `pnpm db:up`. |
| `pnpm typecheck`, `pnpm lint` | |
| `pnpm db:up`, `db:down`, `db:reset` | Local Postgres (`db:reset` deletes the data). `POSTGRES_PORT` changes the port if 5432 is taken. |
| `pnpm db:migrate`, `db:deploy`, `db:studio`, `db:generate` | Prisma. |
| `pnpm contracts:sync` | Copies `src/contracts` into the frontend with a sha256 lock (see [Contracts](#contracts)). |
| `pnpm docs:generate` | Writes `docs/openapi.json` and `docs/errors.mdx` from the code (a test fails while either is stale). |
| `pnpm docs:dev`, `docs:check` | The docs on http://localhost:3333 / Mintlify's build and broken-link checks. |
| `pnpm skills:check` | Checks `agent-skills/` exactly as the worker loads it. |
| `pnpm magica:try` | Runs each Magica tool once against the real API (uses Magica credits). |
| `pnpm media:backfill` | One-off: adds media generated before the Media Library existed to it. Safe to repeat. |
| `pnpm smoke` | `scripts/smoke.sh` against a running API (needs `curl`, `jq` and `TEST_TOKEN`; `BASE_URL` for a deployed one). |

The start scripts pass `--no-experimental-webstorage`, because Node 25+ otherwise prints a `localStorage` warning on every start.

## Architecture

```
                     Bearer token (Clerk)                  ┌──▶ OpenRouter (openrouter/free)
browser ─────────────────────────────▶ Express API         │
  │  ▲                                 │      │      Trigger.dev worker
  │  │ realtime: one run's chunks      │      └────▶ agent-turn ──▶ magica-tool (one per paid call) ──▶ Magica API
  │  └─ and status (read-only token) ◀─┼──────────── │                deliver-webhook, webhook-sweeper ──▶ your URL
  │                                    ▼             ▼
  │ tus upload                    Postgres (the source of truth)
  └──────────▶ Transloadit ── finished-upload report ──▶ API
API clients ── x-api-key ──▶ /v1 (same API, same rules)
```

- **The API** (Railway) checks, writes and hands work over. It never waits on a model. A send writes a few rows and starts a task; the answer to an approval completes a waitpoint token.
- **The worker** (Trigger.dev) runs four tasks:
  - **`agent-turn`:** the model loop, at most 10 steps and 10 minutes, where time spent waiting for an approval doesn't count.
  - **`magica-tool`:** one durable child task per paid tool call.
  - **`deliver-webhook`:** sends one signed event, with retries.
  - **`webhook-sweeper`:** every 5 minutes, starts any delivery that was recorded but never handed to a task.
- **Postgres is the source of truth.** Realtime (Trigger.dev streams and run metadata) is only transport. Everything it shows is also saved, so `GET /api/chats/:chatId/active-run` can always rebuild the screen after a reload or a dropped stream.

```
src/
  app.ts, server.ts   Express app and process lifecycle (graceful shutdown)
  env/                Zod env schemas: base (both), server (API), worker
  contracts/          Zod schemas and helpers shared with the frontend (the source of truth)
  auth/               Clerk verification and lazy user provisioning
  middleware/         request context, CORS, rate limits, errors
  routes/             /api (the app) and /v1 (the public API)
  services/           turns (send, retry), runs (finalizeRun), reconcile, credits, tool invocations, waitpoints,
                      uploads, media, search, API keys, idempotency, webhooks, completions
  agent/              the turn (runTurn), tool steps, context window, prompt, outcomes
  tools/              tool registry, Magica tools, skill tools, propose_plan, prices
  skills/             skill loading and checks (the files live in agent-skills/)
  waitpoints/         the generic wait (waitpoint tokens + the Waitpoint row)
  webhooks/           events, dispatch (outbox), signed delivery
  trigger/            the Trigger.dev tasks (thin wrappers around the above)
  openapi/            the OpenAPI document and errors page, generated from contracts
  lib/                logger, errors, Magica, OpenRouter, Trigger.dev and Transloadit clients, signing, helpers
prisma/               schema and migrations
agent-skills/         image-generation, image-editing, video-merging (SKILL.md + assets)
docs/                 the Mintlify site (guides, generated reference and errors page)
scripts/              contracts sync, docs generator, smoke test, skills check, Magica try-out, media backfill
tests/                unit and integration (real Postgres; Clerk and Trigger.dev mocked)
```

### Data model

- **User** (Clerk id): `balance` and `held` credits.
- **Chat**: `title`, `isPinned`, `lastMessageAt`.
- **Message**: `role` and `status`; `content` (plain text) and `contentBlocks` (JSONB, validated with Zod); `clientMessageId` (unique per chat).
- **AgentRun**: one turn. It links the question to its reply and holds:
  - the status and `mode` (default or plan), and `triggerRunId`;
  - the routed model, tokens, and a safe error code and message;
  - `retryOfRunId`.

  A partial unique index allows only one `PENDING`/`RUNNING` run per chat.
- **ToolInvocation**: one tool call, made by a run, or standalone from `/v1/tools` (then `agentRunId` is null and `userId` pays). It holds:
  - the status: `PENDING` → `DISPATCHING` → `RUNNING` → `COMPLETED` / `FAILED` / `CANCELLED`;
  - the sanitized input and the output;
  - the credits charged, and Magica's own cost.
- **RunSkill**: the exact skill text a run loaded, with its sha256.
- **Waitpoint**: a pause for the user (`PLAN` or `CREDIT`), with its payload, answer and expiry. At most one pending per run.
- **CreditLedger**: every grant, hold, charge and release, each with a unique idempotency key.
- **Upload**, **MediaAsset**, **Attachment**: direct uploads, the Media Library (uploaded and generated files), and a message's files in order.
- **ApiKey**: a SHA-256 hash, a 12-character prefix to show, per-minute and per-day limits, and an optional expiry.
- **IdempotencyRecord**: one stored answer per (user, endpoint, `Idempotency-Key`), for 24 hours.
- **WebhookEndpoint**, **WebhookSubscription**, **WebhookDelivery**:
  - an endpoint per user and URL, with its signing secret encrypted;
  - what each started piece of work asked for;
  - an outbox of deliveries, one per subscription and event.

CHECK constraints keep balances, holds and charges from going negative, and keep waitpoints and deliveries in consistent states.

### API

**The app's API (`/api`).** It uses `Authorization: Bearer <Clerk session token>`; cookies are ignored. Errors are `{ "error": "<safe message>", "code": "<CODE>", "details"?: {...} }`. Another user's chat, run, file or key is a 404, never a 403, so nothing leaks.

| Route | |
|---|---|
| `GET /api/health` | Checks the database. |
| `GET /api/credits` | `{ balance, held }`. |
| `GET /api/models` | The model the agent uses and its recent health (`available`, `degraded`, `unavailable` or `unknown`, with a reason, such as the daily cap). |
| `GET /api/chats?cursor&limit`, `POST /api/chats` | Pinned first, then most recent activity / a new chat. |
| `GET /api/chats/search?q` | Chats whose title or messages match (trigram indexes). |
| `GET`, `PATCH`, `DELETE /api/chats/:chatId` | `PATCH` takes `title` and/or `isPinned`. `DELETE` also ends an active run. |
| `GET /api/chats/:chatId/messages?cursor&limit` | Newest page first; each page is oldest to newest. |
| `POST /api/chats/:chatId/messages` | Sends a message and starts a turn: `{ content, clientMessageId, attachments?, mode? }`. |
| `GET /api/chats/:chatId/active-run` | The run in flight, a fresh realtime token, the partial reply and any pending waitpoint. |
| `POST /api/runs/:runId/cancel`, `/retry` | Stop a run / answer the latest failed or stopped question again. |
| `POST /api/waitpoints/:waitpointId/respond` | `approve`, `request_changes` (with feedback) or `reject`. |
| `POST /api/uploads`, `/:uploadId/complete` | Signs a direct upload to Transloadit / records its result. `/api/uploads/notify` takes Transloadit's own report, proven by an HMAC. |
| `GET /api/media?source&q&cursor` | The Media Library (uploaded and generated), newest first. |
| `GET`, `POST /api/api-keys`, `PATCH`, `DELETE /api/api-keys/:apiKeyId` | List, create (the key is shown once), rename or change limits, revoke. |

**The public API (`/v1`).** It takes an API key (`x-api-key` or `Authorization: Bearer mgc_…`) or a Clerk token, and any origin may call it. It covers sending messages, chat completions, runs (read, cancel, answer approvals), chats and messages, standalone tool runs, credits and media. Work that takes time returns `202` with a run to poll, or to be told about by webhook. Every response carries `x-api-version: 1` and `x-trace-id`, and every error includes `traceId`. The full reference is in [`docs/`](docs) and `docs/openapi.json`.

### A turn, end to end

1. **Send.** One transaction:
   - places the credit hold;
   - writes the user message (with its attachments), a `STREAMING` reply placeholder and a `PENDING` run;
   - names the chat from a first message.

   A second active run in the chat is 409 `RUN_ACTIVE`; too little credit is 402.
2. **Dispatch.** After the commit, the API starts `agent-turn`, with the run id as Trigger.dev's idempotency key.
   - If that fails, the send is undone and the answer is 503, which means nothing happened.
   - On success the answer is 201, with the ids and a read-only realtime token for this one run.
3. **Run.** The worker claims the run (`PENDING` → `RUNNING`) and builds the context (the conversation, attachments as links, and the skills index). Then it loops for up to 10 steps:
   - **Stream.** It streams the model's text as chunks on the `chunks` stream, and saves the partial reply about once a second.
   - **Inline tools.** `load_skill`, `read_skill_asset` and `propose_plan` run inside the turn.
   - **Paid tools.** Magica calls run together as one batch of `magica-tool` child tasks. Each holds its estimate first; if it completes it is charged once, exactly what Magica reports it used (1:1), and the rest is released; otherwise all of it is released.
   - **Waits.**
     - In plan mode, paid tools are refused until a plan is approved: the agent calls `propose_plan`, and the turn waits on a waitpoint.
     - A step costing more than `CREDIT_APPROVAL_THRESHOLD` also waits, unless an approved plan covers it.
     - A wait never times out the task. An unanswered one expires after 30 minutes, and the turn fails with `WAITPOINT_EXPIRED` (retryable).
4. **End.** Every ending goes through `finalizeRun`, a compare-and-set that runs once per run: the final reply and status, the hold released, model and tokens recorded, open waitpoints closed, and webhooks raised. The worker ends the run itself. The task's failure and cancel hooks cover crashes and time-outs, and cancel, chat delete and stale-run recovery use the same function.

While it runs, the run's metadata follows the required status model: `thinking` → `working` (writing, or using a tool, shown by `currentTool`) → `complete`, `failed` or `cancelled`, plus `waiting` while a waitpoint is pending and `stopping` while a cancel is carried out.

## Key decisions

### Runs
- **Express instead of Next.js route handlers.** A separate API keeps the long-lived pieces (the Trigger.dev client, the database pool, rate limits) out of the frontend's serverless functions, and lets both repos deploy on their own.
- **One active run per chat, enforced by the database** (a partial unique index), not by a check-then-insert that two requests could both pass.
- **`finalizeRun` is the only way a run ends.** It is a compare-and-set on the run's status, so a worker finishing, a cancel, a crash hook and stale-run recovery can race, and exactly one of them wins. Credits, waitpoints and webhooks are settled in that same place.
- **Idempotent send and retry.** The client picks `clientMessageId`; sending it again returns the same turn. A retry creates a new run for the same question (only for the latest turn, only after a failure or stop), and a unique `retryOfRunId` turns a double click into one retry.
- **Stale runs recover themselves, but waiting isn't stale.**
  - A run that was never dispatched is ended after 60 s.
  - A run in Trigger.dev's queue is left alone, up to its 10-minute queue TTL.
  - A started run never outlives its time limit plus slack, not counting time spent waiting for an approval.
  - This happens when a run is read or a send finds the chat busy, so there's no background job to monitor.
- **The model is retried only before its first output** (3 attempts, jittered, `Retry-After` honoured). After text has streamed, a retry would rewrite what the user is reading, so the turn fails and keeps the partial reply. The OpenRouter daily cap is its own code (`MODEL_DAILY_LIMIT`) with the reset time, and is never retried.
- **Safe errors.** Every failure becomes a fixed code and message. Provider text, keys and stack traces never reach a client; `docs/errors.mdx` lists them all.

### Streaming and contracts
- **One fold, shared by both repos.** `foldChunks` in `src/contracts/fold.ts` turns stream chunks into content blocks. The worker uses it to save the partial reply, and the browser uses it to draw the live one, so they can't disagree.
- **Contracts are pushed from the backend** (see [Contracts](#contracts)). The frontend never edits or pulls them; its build fails if a copy was changed.

### Tools and skills
- **`DISPATCHING` before every external call.** A paid Magica call is marked `DISPATCHING` in the database before the request goes out. Magica has no idempotency key, so a second POST is a second paid run:
  - a call that crashed before that mark is sent;
  - a call whose Magica run id was saved is resumed;
  - a call that might have reached Magica is never sent again; it is reported as unconfirmed and not charged.
- **Paid calls are durable child tasks.** Each `magica-tool` task's idempotency key is (run, tool call). A turn's parallel calls run as one batch, and results return in the order the model asked for them.
- **Adaptive Magica polling.** A started Magica run is checked every 3 s at first, then every 5 s, 10 s and finally 15 s as it runs longer, within Magica's per-key rate limit (60 a minute). Status checks are retried through short trouble; a start is retried only when Magica certainly didn't start it (429).
- **Skills are pinned per turn.** Skills are application files (`agent-skills/<name>/SKILL.md`), checked when the worker boots. Only names and descriptions go into the prompt; the body is loaded on demand. Each load is stored with its sha256 (`RunSkill`), so a second load in the same run, or a retry, gets the same text even if the file changed in between.
- **Tool inputs are checked against what the conversation contains.** A tool may only use links that appear in the conversation or that a tool produced, so the model can't invent a URL. The stored and displayed input is sanitized.

### Waitpoints (plan and spend approval)
- **Native waitpoint tokens plus a database row.** The turn waits with Trigger.dev's `wait.createToken` / `wait.forToken` (SDK 4.6.4). The wait doesn't count against the task's time limit, and a deployed worker checkpoints the run while it waits, so it uses no environment concurrency (checked on production).
- **The `Waitpoint` row is the durable record.** Answering takes a row lock, checks the expiry and completes the token in one step, so a double click, two tabs, or an answer racing the expiry can't both win.
- **One generic mechanism, two types.** Plan approval and credit approval share it. A new type is a payload schema and a decision rule.
- **The model and the user are told different things.** When a paid tool is refused (no approved plan, or the spend was declined), the user's card says why in their terms, while the model gets wording that stops it retrying.

### Credits
- **Every balance change is a ledger row in the same transaction,** with a unique idempotency key, so nothing is charged or released twice.
- **A turn holds a small admission amount; each paid call holds an estimate, then pays its real cost.** The estimate is worked out from the call's input with Magica's published prices (`src/tools/costs.ts`: GPT Image 2 by quality and size, Crop Image flat, Merge Videos per minute), and is used for the hold and the spend approval; a plan prices its steps at each tool's typical cost. On success the call is charged exactly Magica's reported `creditUsed`, one app credit per Magica credit, and the rest of the hold is released. A call that costs more than its estimate is charged in full from the user's available credits, never below zero. If Magica reports no cost, the estimate is charged. On failure, stop or doubt, nothing is charged. Model calls cost nothing (the free router has no price).

### Public API and webhooks
- **API keys:** `mgc_` plus 43 random base64url characters; only a SHA-256 hash is stored. They're labelled, limited to 10 active per user, with per-minute and per-day limits (60 and 1,000 by default) and an optional expiry. Revoked or expired keys stop working at once.
- **The same rules as the app.** `/v1` calls the same services as `/api`, so a key can't do anything the signed-in user couldn't, and sends share the same per-user send limit.
- **`Idempotency-Key` on every start.** The first request records `PENDING`, and the answer is stored for 24 hours. A repeat gets the same answer (`Idempotent-Replayed: true`). The same key with a different body, or while the first is still running, is a 409. A failure releases the key.
- **Chat completions, kept lean.** `POST /v1/chat/completions` takes the OpenAI shape with `model: "openrouter/free"`. The conversation becomes a chat, and the call waits up to 60 s, then returns the run to poll.
- **Svix-compatible webhooks.** These are signed with the `svix-id`, `svix-timestamp` and `svix-signature` headers, so receivers can verify them with the `svix` libraries.
  - **Secrets:** one signing secret per user and URL, encrypted at rest with AES-256-GCM.
  - **Outbox:** events are recorded in the same transaction as the state change, then delivered by a task with retries (6 attempts, backoff from 1 to 16 minutes), one delivery per event.
  - **Safe delivery:** https only, a 10 s timeout, redirects never followed, and private, loopback and link-local addresses refused. The address is checked again on the connection actually made, so DNS can't be switched to an internal one after registration.
- **The docs come from the code.** `docs/openapi.json` is generated from the Zod contracts, and `docs/errors.mdx` from the error map. Tests fail when either is stale, when an example in the guides doesn't parse with its schema, or when a failure code isn't documented.

### Uploads, media and search
- **Uploads go straight from the browser to Transloadit** (tus), signed by the API so the secret never reaches the browser. The API records the result from the browser, or from Transloadit's own report when `PUBLIC_API_URL` is set (verified with an HMAC). Limits: 500 MB a file, 10 attachments a message, 20 uploads in flight per user, and 5 GB a month for the whole app (the Transloadit Community plan's allowance).
- **No extra storage, by choice.** Files stay on Transloadit's temporary storage, which deletes them after 24 hours. A file counts as expired after 23 hours:
  - it is never given to the model or offered in the library;
  - sending it asks for a re-upload.

  Generated media lives on Magica's CDN and doesn't expire.
- **Attachments reach the model as links** (`[Attached image: <url>]`). This works with every free model, and the Magica tools take URLs.
- **Search uses trigram indexes** (`pg_trgm`) on chat titles and message content, bounded to the caller's own messages, so `ILIKE '%term%'` stays fast.

### Platform
- **Auth is Bearer-only** on `/api`, so there's no CSRF surface.
  - A bad or missing token is 401.
  - Clerk being unreachable is 503, so the app doesn't sign the user out over an outage.
  - Users are created on first sight.
- **CORS:** `/api` allows only `FRONTEND_ORIGIN`. `/v1` allows any origin with no credentials, because keys travel in headers and never in cookies; that lets the docs' playground and browser clients call it.
- **Rate limits:**
  - `/api`: 300 requests a minute per user (60 per IP when signed out);
  - sends: 10 a minute per user;
  - `/v1`: per-key minute and day counters, and 30 failed sign-ins a minute per IP.
- **Timeouts everywhere:**
  - 8 s to verify a sign-in, 5 s to get a database connection, 15 s per statement;
  - 8 s per Trigger.dev call and 10 s per webhook delivery;
  - a stall timeout on the model stream, and 10 s for in-flight requests on shutdown.
- **Logs:** pino, JSON in production and pretty in development. Every request gets a trace id (an incoming `x-trace-id` is honoured if it looks safe). It travels in task payloads, so the API's and the worker's lines for one turn share it, along with `chatId`, `runId` and `messageId`.
- **Imports:** `#src/*` (Node subpath imports). The custom `magica-source` condition points them at the TypeScript sources for tsx, tsc, Vitest and the Trigger.dev bundler, and at `dist/` for `pnpm start`. A test checks that the worker bundle never pulls in API-only code.

## Many turns at once

The send path only writes a few rows and hands the turn to Trigger.dev, so accepting 1,000 turns at once is cheap. How many *run* at once is set by three limits:

1. **`AGENT_CONCURRENCY_LIMIT`** (default 20): the agent task's queue. Turns above it wait, durably, and are shown to the client as a `PENDING` run. Nothing fails for waiting.
2. **Your Trigger.dev plan's concurrency** for the environment. Set it at or above the queue limit.
3. **OpenRouter's free rate limits:** the real ceiling, which no setting removes. Raising the queue limit past what the free route allows only turns waiting into 429s, so the queue limit is deliberately a throttle.

At 1,000 concurrent turns, every turn is accepted, holds its credits, and runs as capacity allows, in order. None is duplicated, lost or charged twice, and each ends exactly once.

The database needs one setting for this. Every Trigger.dev run is its own process with its own pool, so point the worker at a pooled URL (PgBouncer, or Neon's pooled connection string) and set `DATABASE_POOL_MAX=1` or `2` there. Partial-reply saves are about one small update per second per running turn.

## Contracts

`src/contracts/` holds the Zod schemas and helpers (such as `foldChunks`) that both repos use. The backend is the source of truth:
- `pnpm contracts:sync` copies the files into `../magica-frontend/contracts/` (override with `FRONTEND_REPO_PATH`) and writes `contracts.lock.json`, with a sha256 per file.
- The frontend only verifies with `pnpm contracts:check`, which also runs before its build, and never edits the copies.
- Contract file names are lowercase letters only (`apikeys.ts`, `publicapi.ts`), and imports between them avoid anything Next.js can't resolve.

Before syncing, check the change on a scratch copy of the frontend: `contracts:check`, `tsc`, tests and `next build`.

The same schemas generate the public API's OpenAPI document (`pnpm docs:generate`), so the docs, the server and the frontend share one definition.

## Database migrations

- **Forward:** create with `pnpm db:migrate` (development), and apply with `pnpm db:deploy` in every other environment, before starting the new code. Migrations use `DIRECT_URL` (non-pooled).
- **Rollback:** Prisma has no down migrations. Write a new forward migration that reverses the change, and deploy it. Each migration's header comment holds its exact rollback SQL.
- **Compatibility:** every migration is additive (new tables, nullable columns, indexes), so the previous code keeps running against the new schema, except where noted below.
- **Plain SQL that Prisma can't express:** the partial unique indexes, the CHECK constraints and the trigram indexes. Keep them in any migration that rebuilds those tables.

| Migration | Forward | Rollback |
|---|---|---|
| `init` | Users, chats, messages, runs, tool invocations, the credit ledger; the one-active-run index and CHECKs. | Drop the tables (no data to keep at the time). |
| `drop_user_email_unique` | `User.email` is informational only. | Recreate the unique index (only if emails are unique). |
| `agent_run_completed_at_index` | Index for the model status. | Drop the index. |
| `agent_run_retry_of` | `retryOfRunId`, unique. | Drop the constraint, index and column. |
| `add_run_skill` | `RunSkill`. | Drop the table. |
| `tool_invocation_provider_cost` | Magica's own cost per call; non-negative CHECKs. | Drop the column. |
| `chat_search` | `pg_trgm` and three indexes. On a big table, build them by hand first with `CREATE INDEX CONCURRENTLY`. | Drop the indexes and extension. |
| `uploads_and_media` | `Upload`, `MediaAsset`, `Attachment`. | Drop the three tables. |
| `waitpoints` | `Waitpoint`, one pending per run, state CHECKs. | Drop the table and enums. |
| `run_mode` | `AgentRun.mode` (default `DEFAULT`). | Drop the column and enum. |
| `api_keys` | `ApiKey`. | Drop the table. |
| `idempotency` | `IdempotencyRecord`. | Drop the table and enum. |
| `standalone_tool_runs` | `ToolInvocation.userId` (backfilled), `agentRunId` made nullable. **Not purely additive:** older code can't read standalone calls. | Delete standalone calls, restore NOT NULL, drop `userId`. |
| `webhooks` | Endpoints, subscriptions, deliveries. | Drop the three tables and the enum. |

## Testing

`pnpm test:run` runs about 1,900 tests in two projects:
- **Unit tests** cover pure code: contracts, the chunk fold, the OpenRouter and Magica clients against local fake servers, webhook signing (checked with the official `svix` package), URL safety, env parsing, rate limits, and so on.
- **Integration tests** run against a real Postgres (`magica_test`, truncated between tests), with the real migrations and constraints. Clerk, Trigger.dev and webhook dispatch are mocked at the module boundary, and the agent turn runs with a scripted fake model.
- **Races are tested directly:** two answers to one waitpoint, a send racing a retry, an 11th API key, a repeated `Idempotency-Key`.
- **Drift tests:**
  - `scripts/smoke.sh` runs inside the suite;
  - the worker bundle must not import API code;
  - `docs/openapi.json` must match the routes and contracts;
  - every docs example must parse with its schema.
- **Checked two more ways:** the suite runs in two time zones (UTC and Asia/Kolkata), and key rules were mutation-checked (broken on purpose to confirm a test fails).

Real Clerk, Trigger.dev, OpenRouter, Magica, Transloadit and webhook deliveries were checked by hand in each phase; the results are in the issues.

## Deploying

Five services, set up in this order: the database, the worker, the API, the frontend, then the docs.

### 1. Database (Neon)
Create a Neon project, in the region you'll run the API in. Neon gives two connection strings:
- the **pooled** one (its host contains `-pooler`), which the app uses as `DATABASE_URL`;
- the **direct** one, which migrations use as `DIRECT_URL`.

Our client sends a 15 s statement timeout when it connects. If the pooler rejects that ("unsupported startup parameter"), set `DATABASE_STATEMENT_TIMEOUT_MS=0` and put the limit on the database role instead: `ALTER ROLE <your role> SET statement_timeout = '15s';`

### 2. Worker (Trigger.dev production)
In the Trigger.dev dashboard, set the **Production** environment's variables:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon's pooled URL |
| `DATABASE_POOL_MAX` | `2` (every run is its own process; the pooler multiplexes them) |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `15000`, or `0` (see above) |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | your key; `openrouter/free` |
| `MAGICA_API_KEY`, `MAGICA_BASE_URL` | your key; `https://inference.magica.com` |
| `WEBHOOK_SECRET_KEY` | the same value as the API's |
| `AGENT_CONCURRENCY_LIMIT`, `CREDIT_APPROVAL_THRESHOLD` | optional; `20` and `600000` by default |
| `NODE_ENV`, `LOG_LEVEL` | `production`, `info` |

Then deploy from this repo with `pnpm trigger:deploy`, which uses the pinned CLI and reads `TRIGGER_PROJECT_REF` from `.env.local`; run `pnpm exec trigger login` first if needed. Don't use `trigger.dev@latest`. The dashboard should then list `agent-turn`, `magica-tool`, `deliver-webhook` and the `webhook-sweeper` schedule. `pnpm exec trigger deploy --dry-run` builds the same bundle without deploying it.

If the Production environment shows no secret key for the API, create one (API keys → New). It becomes the API's `TRIGGER_SECRET_KEY`.

### 3. API (Railway)
Create a Railway service from the GitHub repo. `railway.json` holds the build (`pnpm build`), the pre-deploy migration (`pnpm db:deploy`), the start command (`pnpm start`) and the health check (`/api/health`). Railway may not pick the file up by itself, so in the service settings either set **Config-as-code path** to `railway.json`, or set the pre-deploy command to `pnpm db:deploy`.

After the first deploy, check that the tables exist, not just the health check. `/api/health` only runs `SELECT 1`, so it passes on an empty database.

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL`, `DIRECT_URL` | Neon's pooled and direct URLs |
| `DATABASE_POOL_MAX`, `DATABASE_STATEMENT_TIMEOUT_MS` | `10`; as for the worker |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | the same Clerk instance as the frontend |
| `TRIGGER_SECRET_KEY` | the **production** secret key (`tr_prod_…`), so runs go to the deployed worker |
| `FRONTEND_ORIGIN` | the frontend's URL, set after step 4 |
| `TRUST_PROXY` | `1` (Railway runs one proxy in front) |
| `WEBHOOK_SECRET_KEY` | the same value as the worker's |
| `TRANSLOADIT_AUTH_KEY`, `TRANSLOADIT_AUTH_SECRET` | your Transloadit keys |
| `PUBLIC_API_URL` | the service's own `https://` domain |
| `CREDIT_STARTING_BALANCE`, `CREDIT_ADMISSION_HOLD` | optional |

Railway sets `PORT`. Generate a public domain for the service, then check `https://<domain>/api/health`.

### 4. Frontend (Vercel)
Deploy `magica-frontend` with `NEXT_PUBLIC_BACKEND_URL` set to the API's URL, plus its Clerk keys (see its README). Then set the API's `FRONTEND_ORIGIN` to the frontend's production URL, exactly as the browser shows it (no trailing slash), and redeploy the API. CORS and Clerk's `authorizedParties` allow only that one origin, so Vercel preview deployments are refused by design.

### 5. Docs (Mintlify)
Connect Mintlify's GitHub app to this repo (only this repo), set the docs source to the branch you deploy from, and turn on "docs.json is in a subdirectory" with the path `/docs`. Every push that changes `docs/` redeploys the site. `docs/openapi.json` lists the production API first and `http://localhost:3000` second, so the hosted playground calls production. Point it elsewhere with `OPENAPI_SERVER_URL=<url> pnpm docs:generate`.

### 6. Check it
- `TEST_TOKEN=<token from the deployed frontend> BASE_URL=https://<api domain> pnpm smoke`.
- A real image turn and a plan-mode turn in the deployed app.
- One `/v1` call with an API key, from curl and from the docs' playground.

## Known limitations

- **Rate limits and `/v1` counters live in memory, per process.** With several API instances, each keeps its own counts.
- **Uploads last 24 hours.** They stay on Transloadit's temporary storage; after 23 hours a file shows as expired and must be uploaded again.
- **Attachments are links, not vision.** The model reads `[Attached image: <url>]` and can pass the link to a tool, but doesn't see the picture.
- **Step by Step is disabled.** It is shown on the plan card as in the reference, but an approved plan runs all its steps.
- **The free router decides the model.** It sometimes routes to a weak or non-chat model, and it has a daily cap (reported as `MODEL_DAILY_LIMIT`, with the reset time).
- **Chat completions are lean.** They take only `openrouter/free`, no streaming, and text in and out.
- **Webhooks have no management API.** There's no delivery list, replay or secret rotation; a secret is per user and URL.
- **Skills have no versions.** Skills are files in the repo. A run pins the text it loaded, but there's no version history or per-user choice.
- **Waiting runs and the agent queue.** On the deployed worker, a run waiting for an approval is checkpointed and uses no environment concurrency. The `agent-turn` queue still counts it, though, so 20 plans left waiting at once (`AGENT_CONCURRENCY_LIMIT`) would hold new turns in the queue until they're answered or expire (30 minutes). In `trigger dev`, a waiting run also keeps its slot, because dev doesn't checkpoint.

## What I'd do with more time

- A shared store (Redis) for rate limits and `/v1` counters.
- An MCP server over the public API.
- Step by Step plan execution, approving each step.
- Skill versioning: stored versions, rollout per user, and a run recording which version it used.
- S3-compatible storage (a private bucket with signed links), so uploads outlive 24 hours.
- Vision: send attached images to vision-capable models.
- Webhook management: list deliveries, replay one, and rotate a secret.
- Streaming chat completions.
- CI running the suite against a Postgres service.

## Issues found in the reference

- **Stopping a run while its plan waits for approval** left the reference (magica.com) stuck. Here, Stop ends the run cleanly: the waitpoint is cancelled, the plan card clears, the credits held are released, and the turn can be retried.
