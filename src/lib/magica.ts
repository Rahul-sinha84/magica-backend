import { z } from "zod";
import { ToolError } from "#src/tools/errors.js";

// The Magica model API: start a run, wait for it to finish, and read each model's current input schema. Only the
// worker uses it. Rules learned from the real API:
// - Starting a run has no idempotency key, so a start is only ever retried when Magica certainly did not start it
//   (429). A network failure or 5xx on start is "outcome unknown" and is reported as such, never retried here.
// - Each key is rate limited (60/min, 1,000/day by default), so polling slows down the longer a run takes.
// - Some user agents are blocked by the CDN in front of the API, so ours is set explicitly.

export type MagicaFailure =
  | "AUTH" // 401: the key is wrong or expired
  | "OUT_OF_CREDITS" // 403: the Magica account can't pay for the run
  | "RATE_LIMITED" // 429 that outlasted our retry
  | "INVALID_INPUT" // 400, or input the model's schema doesn't allow
  | "MODEL_UNAVAILABLE" // 404 / 410 on start: unknown or retired model
  | "RUN_NOT_FOUND" // 404 on a status check: Magica doesn't know the run (or doesn't yet, just after it started)
  | "FAILED" // the run ended FAILED
  | "CANCELED" // the run ended CANCELED
  | "TIMED_OUT" // still not finished when we stopped waiting
  | "SERVICE_ERROR" // 5xx or network trouble
  | "BAD_RESPONSE"; // a response we couldn't understand

/** A Magica failure. `message` is safe to show; `detail` is for logs only. */
export class MagicaError extends ToolError {
  /** On a 429: how long Magica asked us to wait, when it said. */
  retryAfterMs: number | null = null;

  constructor(
    readonly failure: MagicaFailure,
    message: string,
    readonly detail: string,
    /** For a start: true when Magica may have started the run anyway (so it must not be started again). */
    readonly outcomeUnknown = false,
  ) {
    super("TOOL_FAILED", message);
    this.name = "MagicaError";
  }
}

const RunStartedSchema = z.object({ runId: z.string().min(1).max(200) });

export const MagicaRunSchema = z.object({
  id: z.string(),
  status: z.string(),
  output: z.unknown().optional(),
  error: z.string().nullable().optional(),
  userMessage: z.string().nullable().optional(),
  creditUsed: z.number().optional(),
});
export type MagicaRun = z.infer<typeof MagicaRunSchema>;

const SchemaFieldSchema = z.object({
  name: z.string(),
  type: z.string().optional(),
  dataType: z.string().optional(),
  required: z.boolean().optional(),
  options: z.array(z.unknown()).optional(),
  default: z.unknown().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  maxLength: z.number().optional(),
});
export const ModelSchemaSchema = z.object({ modelId: z.string().optional(), fields: z.array(SchemaFieldSchema) });
export type ModelSchema = z.infer<typeof ModelSchemaSchema>;

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELED"]);
const IN_PROGRESS = new Set(["QUEUED", "RUNNING"]);

/** How long to wait before each status check: quick at first, slower as the run goes on (rate limits). */
export function pollDelayMs(elapsedMs: number): number {
  if (elapsedMs < 15_000) return 3_000;
  if (elapsedMs < 30_000) return 5_000;
  if (elapsedMs < 60_000) return 10_000;
  return 15_000;
}

/** `Retry-After` as milliseconds: seconds or an HTTP date. Null when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  // a number is only ever seconds (a negative one is junk), never something Date.parse might read as a year
  if (/^\s*[+-]?\d+(\.\d+)?\s*$/.test(header)) {
    const seconds = Number(header);
    return seconds >= 0 ? seconds * 1_000 : null;
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export interface MagicaOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** Waits; the default respects the signal. Replaced in tests so no real time passes. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  requestTimeoutMs?: number;
  /** The longest a start waits on Retry-After before its one retry. */
  maxRetryAfterMs?: number;
  /** Status checks in a row that may fail (429, 5xx, network) before giving up. */
  maxPollErrors?: number;
  schemaTtlMs?: number;
}

export interface WaitOptions {
  signal?: AbortSignal;
  /** How long to wait for the run to finish. */
  maxWaitMs?: number;
  /** Names the work in messages, for example "Image generation". */
  label?: string;
  /**
   * Called after every status check (to persist progress). If it fails (a database blip, say), the failure goes to
   * `onStatusError` and waiting continues: the run is still going and still being paid for, so we keep watching it.
   */
  onStatus?: (run: MagicaRun) => void | Promise<void>;
  onStatusError?: (error: unknown, run: MagicaRun) => void;
}

export interface MagicaClient {
  startRun(nodeType: string, body: { input: Record<string, unknown>; subModelId?: string }, signal?: AbortSignal): Promise<string>;
  getRun(runId: string, signal?: AbortSignal): Promise<MagicaRun>;
  /** Waits until the run reaches a terminal status. Resolves with a COMPLETED run; anything else throws. */
  waitForRun(runId: string, options?: WaitOptions): Promise<MagicaRun>;
  /** The model's current input schema, cached briefly. */
  getModelSchema(modelId: string, signal?: AbortSignal): Promise<ModelSchema>;
}

/** Waits for `work`, but stops waiting (rejecting with the signal's reason) as soon as `signal` aborts. */
function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const USER_AGENT = "magica-agent-backend/1.0";
/** Magica's responses are small JSON documents; anything far bigger is not one, and is not read into memory. */
export const MAX_RESPONSE_BYTES = 1_048_576;

class ResponseTooLarge extends Error {}

/** Reads a response body as text, refusing (without buffering it) one larger than the limit. */
async function readCapped(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLarge();
  }
  if (!response.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Node's web streams are async iterable; leaving the loop early cancels the rest of the body
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > limit) throw new ResponseTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createMagicaClient(options: MagicaOptions): MagicaClient {
  const {
    baseUrl,
    apiKey,
    fetch: doFetch = fetch,
    sleep = defaultSleep,
    now = Date.now,
    requestTimeoutMs = 15_000,
    maxRetryAfterMs = 30_000,
    maxPollErrors = 8,
    schemaTtlMs = 10 * 60_000,
  } = options;
  const root = baseUrl.replace(/\/+$/, "");
  const schemas = new Map<string, { at: number; schema: ModelSchema }>();
  const schemaRequests = new Map<string, Promise<ModelSchema>>();

  /** One HTTP request. Network trouble and timeouts become MagicaErrors; an outer abort is rethrown as is. */
  async function request(method: "GET" | "POST", path: string, body: unknown, signal: AbortSignal | undefined, unknownOnFailure: boolean) {
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await doFetch(`${root}${path}`, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": USER_AGENT, ...(body !== undefined && { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        // the API never redirects; following one could send the key somewhere else
        redirect: "error",
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason as Error;
      const reason = timeout.aborted ? `timed out after ${requestTimeoutMs} ms` : error instanceof Error ? error.message : "network error";
      throw new MagicaError("SERVICE_ERROR", "The media service couldn't be reached. Please try again.", `${method} ${path}: ${reason}`, unknownOnFailure);
    }
    let json: unknown = null;
    let text: string;
    try {
      text = await readCapped(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (signal?.aborted) throw signal.reason as Error;
      if (error instanceof ResponseTooLarge) {
        // a 2xx to a start may still mean a run exists, so it must not be started again
        throw new MagicaError("BAD_RESPONSE", "The media service returned something unexpected.", `${method} ${path} -> ${response.status}: response larger than ${MAX_RESPONSE_BYTES} bytes`, unknownOnFailure);
      }
      // the body broke off (a timeout or a dropped connection mid-response). For an error status the status says enough;
      // for a success we can't know what it said, so it's a service error (and, for a start, outcome unknown)
      if (response.ok) throw new MagicaError("SERVICE_ERROR", "The media service couldn't be reached. Please try again.", `${method} ${path} -> ${response.status}: response broke off`, unknownOnFailure);
      text = "";
    }
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined; // not JSON (an HTML error page, for example)
      }
    }
    return { response, json, text };
  }

  const detailOf = (method: string, path: string, status: number, json: unknown, text: string) => {
    const message = json && typeof json === "object" && "error" in json ? String(json.error) : text.slice(0, 200);
    return `${method} ${path} -> ${status}: ${message}`;
  };

  /** Turns a non-2xx response into a safe MagicaError. */
  function failure(status: number, detail: string, isStart: boolean): MagicaError {
    if (status === 401) return new MagicaError("AUTH", "Authentication error with the media service.", detail);
    if (status === 403) return new MagicaError("OUT_OF_CREDITS", "The media service is unavailable right now.", detail);
    if (status === 429) return new MagicaError("RATE_LIMITED", "The media service is busy, please try again.", detail);
    if (status === 400) return new MagicaError("INVALID_INPUT", "The media service couldn't use that input. Make sure the links are public images or videos.", detail);
    if (status === 404 || status === 410) return new MagicaError("MODEL_UNAVAILABLE", "This tool isn't available right now.", detail);
    // a 5xx on start may have started the run; on a status check it never matters
    return new MagicaError("SERVICE_ERROR", "The media service had a problem. Please try again.", detail, isStart && status >= 500);
  }

  async function startRun(nodeType: string, body: { input: Record<string, unknown>; subModelId?: string }, signal?: AbortSignal): Promise<string> {
    const path = `/v1/nodes/${encodeURIComponent(nodeType)}/run`;
    for (let attempt = 0; ; attempt++) {
      const { response, json, text } = await request("POST", path, body, signal, true);
      if (response.status === 202 || response.status === 200 || response.status === 201) {
        const started = RunStartedSchema.safeParse(json);
        // accepted but unreadable: a run may exist, so it must not be started again
        if (!started.success) throw new MagicaError("BAD_RESPONSE", "The media service returned something unexpected.", `POST ${path} -> ${response.status}: no runId`, true);
        return started.data.runId;
      }
      const detail = detailOf("POST", path, response.status, json, text);
      if (response.status === 429 && attempt === 0) {
        // a 429 certainly did not start anything, so one retry is safe
        const wait = Math.min(retryAfterMs(response.headers.get("retry-after"), now()) ?? 5_000, maxRetryAfterMs);
        await sleep(wait, signal);
        continue;
      }
      throw failure(response.status, detail, true);
    }
  }

  async function getRun(runId: string, signal?: AbortSignal): Promise<MagicaRun> {
    const path = `/v1/nodes/runs/${encodeURIComponent(runId)}`;
    const { response, json, text } = await request("GET", path, undefined, signal, false);
    if (!response.ok) {
      const detail = detailOf("GET", path, response.status, json, text);
      if (response.status === 404) throw new MagicaError("RUN_NOT_FOUND", "The media service lost track of this request. Please try again.", detail);
      const error = failure(response.status, detail, false);
      if (response.status === 429) error.retryAfterMs = retryAfterMs(response.headers.get("retry-after"), now());
      throw error;
    }
    const run = MagicaRunSchema.safeParse(json);
    if (!run.success) throw new MagicaError("BAD_RESPONSE", "The media service returned something unexpected.", `GET ${path} -> ${response.status}: unreadable run`);
    return run.data;
  }

  // A status check is safe to repeat, so these are retried (up to maxPollErrors in a row): trouble on the way, a rate
  // limit, a run that isn't visible yet just after it started, or an unreadable answer (a proxy's error page, say).
  const transient = (error: unknown) => error instanceof MagicaError && ["SERVICE_ERROR", "RATE_LIMITED", "RUN_NOT_FOUND", "BAD_RESPONSE"].includes(error.failure);

  // The deadline is checked before each wait, so it can be passed by up to one request timeout (15 s by default).
  async function waitForRun(runId: string, { signal, maxWaitMs = 5 * 60_000, label = "The request", onStatus, onStatusError }: WaitOptions = {}): Promise<MagicaRun> {
    const started = now();
    let errorsInARow = 0;
    let extraWait = 0;
    for (;;) {
      const elapsed = now() - started;
      const delay = Math.max(pollDelayMs(elapsed), extraWait);
      if (elapsed + delay > maxWaitMs) {
        throw new MagicaError("TIMED_OUT", `${label} timed out.`, `run ${runId} not finished after ${Math.round(elapsed / 1000)} s`);
      }
      await sleep(delay, signal);
      let run: MagicaRun;
      try {
        run = await getRun(runId, signal);
      } catch (error) {
        if (!transient(error) || ++errorsInARow > maxPollErrors) throw error;
        // a status check is safe to repeat: back off (longer after a 429) and keep waiting
        const after = error instanceof MagicaError ? error.retryAfterMs : null;
        extraWait = Math.min(Math.max(after ?? 0, 2_000 * 2 ** (errorsInARow - 1)), 60_000);
        continue;
      }
      errorsInARow = 0;
      extraWait = 0;
      try {
        await onStatus?.(run);
      } catch (error) {
        onStatusError?.(error, run);
      }
      if (run.status === "COMPLETED") return run;
      if (run.status === "FAILED") {
        // userMessage is Magica's own user-facing explanation; it is safe to show
        throw new MagicaError("FAILED", run.userMessage?.trim() || `${label} failed.`, `run ${runId} FAILED: ${run.error ?? "no detail"}`);
      }
      if (run.status === "CANCELED") throw new MagicaError("CANCELED", `${label} was cancelled.`, `run ${runId} CANCELED`);
      if (!IN_PROGRESS.has(run.status) && !TERMINAL.has(run.status)) {
        // an unknown status: keep waiting (the deadline still applies) rather than guess it is over
        continue;
      }
    }
  }

  function getModelSchema(modelId: string, signal?: AbortSignal): Promise<ModelSchema> {
    const cached = schemas.get(modelId);
    if (cached && now() - cached.at < schemaTtlMs) return Promise.resolve(cached.schema);
    // tool calls arriving together share one request (each request counts against the key's rate limit)
    // The shared request is not tied to any one caller's cancellation (one user stopping must not fail another user's
    // call); each caller only stops waiting for it.
    let pending = schemaRequests.get(modelId);
    if (!pending) {
      pending = fetchModelSchema(modelId).finally(() => schemaRequests.delete(modelId));
      schemaRequests.set(modelId, pending);
    }
    return untilAborted(pending, signal);
  }

  async function fetchModelSchema(modelId: string): Promise<ModelSchema> {
    const cached = schemas.get(modelId);
    const path = `/v1/models/${encodeURIComponent(modelId)}/schema`;
    let reply: Awaited<ReturnType<typeof request>>;
    try {
      reply = await request("GET", path, undefined, undefined, false);
    } catch (error) {
      if (cached) return cached.schema; // the catalog can't be reached: the last schema beats failing the call
      throw error;
    }
    const { response, json, text } = reply;
    if (!response.ok) {
      if (cached) return cached.schema; // a stale schema beats failing the call
      throw failure(response.status, detailOf("GET", path, response.status, json, text), false);
    }
    const schema = ModelSchemaSchema.safeParse(json);
    if (!schema.success) {
      if (cached) return cached.schema;
      throw new MagicaError("BAD_RESPONSE", "The media service returned something unexpected.", `GET ${path}: unreadable schema`);
    }
    schemas.set(modelId, { at: now(), schema: schema.data });
    return schema.data;
  }

  return { startRun, getRun, waitForRun, getModelSchema };
}

/**
 * Checks input against the model's live schema and puts each choice into the exact form the model expects (the agent
 * says "medium", Magica's schema says "Medium"). Missing required fields, choices the model no longer offers, and
 * numbers or text outside its limits are refused with a reason that names the allowed values.
 * Known limit: conditional fields (`showWhen` in the schema) are not interpreted; none of the models we use has them,
 * and Magica itself still validates the run.
 */
export function resolveInput(schema: ModelSchema, input: Record<string, unknown>): Record<string, unknown> {
  const fields = new Map(schema.fields.map((field) => [field.name, field]));
  const problems: string[] = [];
  const resolved: Record<string, unknown> = {};

  for (const field of schema.fields) {
    const value = input[field.name];
    const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
    if (field.required && empty) problems.push(`${field.name} is required`);
  }

  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const field = fields.get(name);
    if (!field) {
      problems.push(`${name} is not an option of this model`);
      continue;
    }
    if (field.options?.length) {
      const match = field.options.find((option) => option === value || (typeof option === "string" && typeof value === "string" && option.toLowerCase() === value.toLowerCase()));
      if (match === undefined) {
        problems.push(`${name} must be one of ${field.options.map(String).join(", ")}`);
        continue;
      }
      resolved[name] = match;
      continue;
    }
    if (typeof value === "number") {
      if (field.min !== undefined && value < field.min) problems.push(`${name} must be at least ${field.min}`);
      if (field.max !== undefined && value > field.max) problems.push(`${name} must be at most ${field.max}`);
    }
    if (typeof value === "string") {
      const limit = field.maxLength ?? (field.dataType === "string" ? field.max : undefined);
      if (limit !== undefined && value.length > limit) problems.push(`${name} must be at most ${limit} characters`);
    }
    resolved[name] = value;
  }

  if (problems.length > 0) {
    throw new MagicaError("INVALID_INPUT", `The media service doesn't accept this input: ${problems.slice(0, 5).join("; ")}.`, `schema check: ${problems.join("; ")}`);
  }
  return resolved;
}

let client: MagicaClient | undefined;

/** The worker's Magica client, configured from its environment. */
export async function magica(): Promise<MagicaClient> {
  if (!client) {
    const { env } = await import("#src/env/worker.js");
    client = createMagicaClient({ baseUrl: env.MAGICA_BASE_URL, apiKey: env.MAGICA_API_KEY });
  }
  return client;
}
