import { z } from "zod";
import { IsoDateTimeSchema } from "./common.js";
import { AudioBlockSchema, ContentBlocksSchema, ImageBlockSchema, VideoBlockSchema } from "./messages.js";
import { CreditPayloadSchema, PlanPayloadSchema, WaitpointSchema, WaitpointStatusSchema } from "./waitpoints.js";

// Name of the Trigger.dev realtime stream that carries AgentStreamChunk items.
export const AGENT_STREAM_ID = "chunks";

// Trigger.dev spells it CANCELED; we normalise to CANCELLED at the boundary.
export const RunStatusSchema = z
  .enum(["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "CANCELED"])
  .transform((status) => (status === "CANCELED" ? "CANCELLED" : status));

export const AgentRunSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  triggerRunId: z.string().nullable(),
  status: RunStatusSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  completedAt: IsoDateTimeSchema.nullable(),
});

// Server-owned snapshot of a run in flight. `partialText` and `partialBlocks` let the polling
// fallback show what has streamed so far, so nothing is lost when realtime drops.
export const ActiveRunResponseSchema = z.object({
  run: AgentRunSchema.nullable(),
  realtimeToken: z.string().nullable(),
  realtimeTokenExpiresAt: IsoDateTimeSchema.nullable(),
  partialText: z.string().nullable(),
  partialBlocks: ContentBlocksSchema,
  // the question the run is waiting on, if it is waiting (absent or null otherwise): a reload shows the card again
  pendingWaitpoint: WaitpointSchema.nullable().optional(),
});

// Run metadata: coarse progress only. The content itself arrives as stream chunks.
// thinking (the model is reasoning, nothing written yet) -> working (writing, or using a tool: see currentTool)
// -> complete | failed | cancelled; stopping while a cancel is being carried out; waiting while the run waits for the
// user to answer a waitpoint (see waitpointId), then working again.
export const AgentStreamStatusSchema = z.enum(["thinking", "working", "waiting", "complete", "failed", "cancelled", "stopping"]);

export const AgentStreamMetadataSchema = z.object({
  status: AgentStreamStatusSchema,
  step: z.string().optional(),
  thinkingDurationMs: z.number().optional(),
  currentTool: z
    .object({
      name: z.string(),
      input: z.record(z.string(), z.unknown()),
      status: z.enum(["running", "completed", "failed"]),
    })
    .optional(),
  error: z.string().optional(),
  // while waiting: the waitpoint the run waits on
  waitpointId: z.string().optional(),
});

const WaitpointStartCommon = { type: z.literal("waitpoint-start"), waitpointId: z.string(), expiresAt: z.iso.datetime({ offset: true }) };

// One item on the Trigger.dev realtime stream. Folding the full array in order always
// yields the same blocks, so a replay never duplicates content.
export const AgentStreamChunkSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text-delta"), delta: z.string() }),
  z.object({ type: z.literal("thinking-delta"), delta: z.string() }),
  z.object({
    type: z.literal("tool-start"),
    toolCallId: z.string(),
    toolName: z.string(),
    toolInput: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("tool-end"),
    toolCallId: z.string(),
    status: z.enum(["completed", "failed"]),
    durationMs: z.number().optional(),
    creditCost: z.number().optional(),
    result: z.unknown().optional(),
    errorMessage: z.string().optional(),
  }),
  z.object({ type: z.literal("asset"), asset: z.discriminatedUnion("type", [ImageBlockSchema, VideoBlockSchema, AudioBlockSchema]) }),
  // the run now waits for the user's answer (the card), and then how it was answered
  z.discriminatedUnion("waitpointType", [
    z.object({ ...WaitpointStartCommon, waitpointType: z.literal("plan"), payload: PlanPayloadSchema }),
    z.object({ ...WaitpointStartCommon, waitpointType: z.literal("credit"), payload: CreditPayloadSchema }),
  ]),
  z.object({
    type: z.literal("waitpoint-end"),
    waitpointId: z.string(),
    status: WaitpointStatusSchema.exclude(["pending"]),
    feedback: z.string().optional(),
    waitedMs: z.number(),
  }),
]);

export type AgentRun = z.infer<typeof AgentRunSchema>;
export type ActiveRunResponse = z.infer<typeof ActiveRunResponseSchema>;
export type AgentStreamMetadata = z.infer<typeof AgentStreamMetadataSchema>;
export type AgentStreamStatus = z.infer<typeof AgentStreamStatusSchema>;
export type AgentStreamChunk = z.infer<typeof AgentStreamChunkSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
