import OpenAI from "openai";
import { env } from "#src/env/worker.js";
import { wellFormed } from "#src/lib/text.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ModelEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "done"; model: string | null; inputTokens: number; outputTokens: number; finishReason: string | null };

/** Why the model could not answer, in terms of what the user can do about it. */
export type ModelFailure = "RATE_LIMITED" | "UNAVAILABLE" | "EMPTY" | "INTERRUPTED" | "REJECTED" | "CONFIG";

// Stable codes for the run row, and wording that is safe to show to the user (nothing about providers or keys).
export const FAILURE_INFO: Readonly<Record<ModelFailure, { code: string; message: string }>> = {
  RATE_LIMITED: { code: "MODEL_RATE_LIMITED", message: "The free model is busy right now. Please try again in a moment." },
  UNAVAILABLE: { code: "MODEL_UNAVAILABLE", message: "The assistant is unavailable right now. Please try again shortly." },
  EMPTY: { code: "MODEL_EMPTY", message: "The assistant didn't return an answer. Please try again." },
  INTERRUPTED: { code: "MODEL_INTERRUPTED", message: "The response was interrupted. What was written so far is kept." },
  REJECTED: { code: "MODEL_REJECTED", message: "The assistant couldn't process this conversation." },
  CONFIG: { code: "MODEL_CONFIG", message: "The assistant isn't available right now." },
};

export class ModelError extends Error {
  constructor(
    readonly failure: ModelFailure,
    detail: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(detail); // for logs only; users get FAILURE_INFO
    this.name = "ModelError";
  }
}

export interface StreamerOptions {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  /** Tries before giving up, counting the first. Only ever retried while nothing has been sent to the user. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** No data for this long means the stream has stalled. */
  stallMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

const DEFAULTS = { maxTokens: 4096, attempts: 3, baseDelayMs: 500, maxDelayMs: 20_000, stallMs: 45_000 };

const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });

/** `Retry-After` is either a number of seconds or a date. Anything else is ignored. */
export function parseRetryAfter(value: string | null | undefined, maxMs: number, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, maxMs) : undefined;
}

// Text arrives in pieces that can cut an emoji in half. Hold a trailing half until its partner arrives, and only then
// decide whether anything is really malformed. NUL characters (which the database cannot store) are dropped.
class TextCleaner {
  private carry = "";
  push(chunk: string): string {
    let text = this.carry + chunk.replaceAll("\u0000", "");
    this.carry = "";
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      this.carry = text.slice(-1);
      text = text.slice(0, -1);
    }
    return wellFormed(text);
  }
  end(): string {
    const leftover = this.carry ? "�" : "";
    this.carry = "";
    return leftover;
  }
}

interface ChunkExtras {
  model?: string;
  error?: { code?: number | string; message?: string };
  choices?: { delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[];
}

function fromStatus(status: number, retryAfterMs: number | undefined, detail: string): ModelError {
  if (status === 429) return new ModelError("RATE_LIMITED", detail, true, retryAfterMs);
  if (status === 408 || status === 425 || status >= 500) return new ModelError("UNAVAILABLE", detail, true, retryAfterMs);
  if (status === 401 || status === 402 || status === 403) return new ModelError("CONFIG", detail, false);
  return new ModelError("REJECTED", detail, false);
}

function headerOf(headers: unknown, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const record = headers as Record<string, string | undefined> | undefined;
  return record?.[name] ?? null;
}

/** Turns whatever went wrong into a ModelError. An abort from outside is not a model failure and passes through. */
function classify(error: unknown, options: { maxDelayMs: number; signal?: AbortSignal; afterOutput: boolean }): unknown {
  if (error instanceof ModelError) return error;
  if (options.signal?.aborted) return error;
  if (error instanceof OpenAI.APIError && typeof error.status === "number") {
    const retryAfter = parseRetryAfter(headerOf(error.headers, "retry-after"), options.maxDelayMs);
    return fromStatus(error.status, retryAfter, `${error.status}: ${error.message}`);
  }
  // connection trouble, a stalled stream, or something the SDK could not parse: worth another try if nothing was sent
  return new ModelError("UNAVAILABLE", error instanceof Error ? error.message : String(error), true);
}

/** Error payloads can arrive inside the stream itself (a provider failing part-way through). */
function fromStreamError(error: NonNullable<ChunkExtras["error"]>): ModelError {
  const status = typeof error.code === "number" ? error.code : Number(error.code);
  return Number.isFinite(status) ? fromStatus(status, undefined, `${status}: ${error.message ?? "stream error"}`) : new ModelError("UNAVAILABLE", error.message ?? "stream error", true);
}

export type ModelStream = (messages: ChatMessage[], signal?: AbortSignal) => AsyncGenerator<ModelEvent>;

export function createStreamer(options: StreamerOptions = {}): ModelStream {
  const { maxTokens, attempts, baseDelayMs, maxDelayMs, stallMs } = { ...DEFAULTS, ...options };
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;
  // retrying is ours, done only where it is safe, so the SDK must not retry on its own
  const client = new OpenAI({ baseURL: options.baseURL ?? env.OPENROUTER_BASE_URL, apiKey: options.apiKey ?? env.OPENROUTER_API_KEY, maxRetries: 0 });
  const model = options.model ?? env.OPENROUTER_MODEL;

  async function* attempt(messages: ChatMessage[], outer?: AbortSignal): AsyncGenerator<ModelEvent> {
    const local = new AbortController();
    const forward = () => local.abort(outer?.reason);
    if (outer?.aborted) forward();
    outer?.addEventListener("abort", forward, { once: true });

    let stalled = false;
    let timer: NodeJS.Timeout | undefined;
    const watch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        local.abort();
      }, stallMs);
    };

    const text = new TextCleaner();
    const reasoning = new TextCleaner();
    let seen = false;
    let usage = { model: null as string | null, input: 0, output: 0, finish: null as string | null };
    try {
      watch();
      const stream = await client.chat.completions.create(
        { model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens, temperature: 0.7 },
        { signal: local.signal },
      );
      for await (const chunk of stream) {
        watch();
        const extras = chunk as unknown as ChunkExtras;
        if (extras.error) throw fromStreamError(extras.error);
        usage.model = extras.model ?? usage.model;
        if (chunk.usage) usage = { ...usage, input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
        const choice = extras.choices?.[0];
        usage.finish = choice?.finish_reason ?? usage.finish;
        const thinking = reasoning.push(choice?.delta?.reasoning ?? choice?.delta?.reasoning_content ?? "");
        if (thinking) {
          seen = true;
          yield { type: "reasoning", delta: thinking };
        }
        const answer = text.push(choice?.delta?.content ?? "");
        if (answer) {
          seen = true;
          yield { type: "text", delta: answer };
        }
      }
      // The SDK ends the iteration quietly (no error) when the request is aborted, so a stop or a stall must be checked for
      // here; otherwise a cut-off answer would look like a finished one.
      if (stalled) throw new ModelError("UNAVAILABLE", `no data for ${stallMs} ms`, true);
      if (local.signal.aborted) throw (outer?.reason ?? new DOMException("The operation was aborted", "AbortError")) as Error;
      // a half emoji at the very end becomes the replacement character rather than vanishing
      const tail = text.end();
      if (tail) {
        seen = true;
        yield { type: "text", delta: tail };
      }
      if (!seen) throw new ModelError("EMPTY", "the stream ended without any content", true);
      yield { type: "done", model: usage.model, inputTokens: usage.input, outputTokens: usage.output, finishReason: usage.finish };
    } catch (error) {
      if (stalled) throw new ModelError("UNAVAILABLE", `no data for ${stallMs} ms`, true);
      throw error;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", forward);
      local.abort(); // also closes the connection if the consumer stopped reading early
    }
  }

  return async function* stream(messages, signal) {
    for (let tryNumber = 1; ; tryNumber++) {
      let sentToUser = false;
      try {
        for await (const event of attempt(messages, signal)) {
          sentToUser = true;
          yield event;
        }
        return;
      } catch (raw) {
        const error = classify(raw, { maxDelayMs, signal, afterOutput: sentToUser });
        if (!(error instanceof ModelError)) throw error; // an abort from outside, or a bug: not the model's failure
        // once anything reached the user it cannot be taken back, so a failure from here on is final
        if (sentToUser) throw new ModelError("INTERRUPTED", error.message, false);
        if (!error.retryable || tryNumber >= attempts) throw error;
        const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (tryNumber - 1)) * (0.5 + random());
        await sleep(Math.min(maxDelayMs, Math.max(error.retryAfterMs ?? 0, backoff)), signal);
      }
    }
  };
}

/** The real thing: the free router, with the settings from the environment. */
export const streamModel: ModelStream = createStreamer();
