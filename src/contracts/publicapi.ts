import { z } from "zod";
import { ErrorResponseSchema, IsoDateTimeSchema } from "./common.js";
import { RunModeSchema, SendMessageBodySchema } from "./messages.js";
import { WaitpointSchema } from "./waitpoints.js";

// The public API, /v1. Authenticated with an API key (`x-api-key: mgc_…` or `Authorization: Bearer mgc_…`) or a
// signed-in session token. Every response carries `x-api-version: 1`. Starting work returns at once with a run id to
// poll. Requests that start work honour an `Idempotency-Key` header (see below).

export const API_VERSION = "1";

/** Every /v1 error: the usual `{ error, code, details? }` plus the request's trace id (also in the x-trace-id header). */
export const V1ErrorResponseSchema = ErrorResponseSchema.extend({ traceId: z.string() });

// `Idempotency-Key`: any 1-255 visible ASCII characters. The same key with the same body (within 24 hours) gives back
// the first answer without doing the work again (header `idempotent-replayed: true`); with a different body, or while
// the first request is still being handled, it is refused (409 IDEMPOTENCY_CONFLICT). A request that failed can be
// tried again with the same key.
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60_000;

// POST /v1/messages: send a message, in a new chat or (with chatId) an existing one. The agent works on it in the
// background: poll GET /v1/runs/{runId}.
export const V1SendMessageBodySchema = SendMessageBodySchema.omit({ clientMessageId: true }).extend({
  chatId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, { error: "That isn't a chat id." })
    .optional(),
});

export const V1MessageAcceptedSchema = z.object({
  chatId: z.string(),
  messageId: z.string(),
  runId: z.string(),
  status: z.literal("queued"),
});

// queued: waiting for a worker. running: working. waiting: paused until you answer `pendingWaitpoint`.
export const V1RunStatusSchema = z.enum(["queued", "running", "waiting", "completed", "failed", "cancelled"]);

const V1AssetSchema = z.object({
  type: z.enum(["image", "video", "audio"]),
  url: z.string(),
  mimeType: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
});

// One paid tool call the run made (GPT Image 2, Crop Image, Merge Videos), with what it produced.
export const V1ToolCallSchema = z.object({
  id: z.string(),
  tool: z.string(),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  input: z.record(z.string(), z.unknown()),
  credits: z.int().nullable(),
  durationMs: z.int().nullable(),
  assets: z.array(V1AssetSchema),
  error: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.nullable(),
});

export const V1RunSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  status: V1RunStatusSchema,
  mode: RunModeSchema,
  // the free model the router picked (known once the run is done)
  model: z.string().nullable(),
  usage: z.object({ inputTokens: z.int(), outputTokens: z.int(), credits: z.int() }),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  // the answer so far: its text, and the media it shows
  reply: z.object({ messageId: z.string(), text: z.string(), assets: z.array(V1AssetSchema) }),
  toolCalls: z.array(V1ToolCallSchema),
  pendingWaitpoint: WaitpointSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  completedAt: IsoDateTimeSchema.nullable(),
});

export const V1RunResponseSchema = z.object({ run: V1RunSchema });

export type V1ErrorResponse = z.infer<typeof V1ErrorResponseSchema>;
export type V1SendMessageBody = z.infer<typeof V1SendMessageBodySchema>;
export type V1MessageAccepted = z.infer<typeof V1MessageAcceptedSchema>;
export type V1RunStatus = z.infer<typeof V1RunStatusSchema>;
export type V1ToolCall = z.infer<typeof V1ToolCallSchema>;
export type V1Run = z.infer<typeof V1RunSchema>;
