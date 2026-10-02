import { z } from "zod";
import { IsoDateTimeSchema, NO_NUL_MESSAGE, noNul } from "./common.js";

// Waitpoints: a run paused until the user answers. Two kinds: approving a plan (plan mode), and approving a spend
// above the approval threshold. While it waits the run is `waiting`; the answer (or the expiry, or a stop) resumes it.

export const WaitpointTypeSchema = z.enum(["plan", "credit"]);

// pending until answered; then approved, changes_requested or rejected by the user, expired (nobody answered in
// time: the turn fails and can be retried), or cancelled (the run was stopped or ended while it waited)
export const WaitpointStatusSchema = z.enum(["pending", "approved", "changes_requested", "rejected", "expired", "cancelled"]);

export const WaitpointActionSchema = z.enum(["approve", "request_changes", "reject"]);

/** What each kind of waitpoint can be answered with. A plan: Run All (approve) or Request Changes; a spend: Approve or Reject. */
export const WAITPOINT_ACTIONS = {
  plan: ["approve", "request_changes"],
  credit: ["approve", "reject"],
} as const satisfies Record<z.infer<typeof WaitpointTypeSchema>, readonly z.infer<typeof WaitpointActionSchema>[]>;

/** An unanswered waitpoint expires after this long. */
export const WAITPOINT_LIFETIME_MS = 30 * 60_000;

export const FEEDBACK_MAX = 2000;

// ---- what is being approved ----

export const PlanStepSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  // the tool this step uses, if any
  tool: z.string().max(64).optional(),
  // app credits, from the tool's price
  estimatedCredits: z.int().min(0).max(1_000_000_000),
});

export const PlanPayloadSchema = z.object({
  title: z.string().trim().min(1).max(200),
  overview: z.string().trim().max(2000),
  steps: z.array(PlanStepSchema).min(1).max(20),
  notes: z.string().trim().max(2000).optional(),
  totalCredits: z.int().min(0),
});

export const CreditCallSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  credits: z.int().min(0),
});

export const CreditPayloadSchema = z.object({
  calls: z.array(CreditCallSchema).min(1).max(100),
  totalCredits: z.int().min(0),
});

// The payload depends on the kind, so both travel together.
const PlanWaitpointFields = { type: z.literal("plan"), payload: PlanPayloadSchema };
const CreditWaitpointFields = { type: z.literal("credit"), payload: CreditPayloadSchema };

// ---- the waitpoint itself ----

const WaitpointCommon = {
  id: z.string(),
  runId: z.string(),
  status: WaitpointStatusSchema,
  // what the user wrote with their answer (Request Changes always has some)
  feedback: z.string().nullable(),
  expiresAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  resolvedAt: IsoDateTimeSchema.nullable(),
};

export const WaitpointSchema = z.discriminatedUnion("type", [z.object({ ...WaitpointCommon, ...PlanWaitpointFields }), z.object({ ...WaitpointCommon, ...CreditWaitpointFields })]);

// POST /api/waitpoints/{id}/respond. `feedback` is required with request_changes. Answering an already-answered (or
// expired, or cancelled) waitpoint changes nothing and returns it as it stands, so a repeated click is harmless.
export const RespondWaitpointBodySchema = z.strictObject({
  action: WaitpointActionSchema,
  feedback: z.string().trim().min(1).max(FEEDBACK_MAX).refine(noNul, { error: NO_NUL_MESSAGE }).optional(),
});

export const RespondWaitpointResponseSchema = z.object({ waitpoint: WaitpointSchema });

// ---- in the reply ----

const WaitpointBlockCommon = {
  type: z.literal("waitpoint"),
  waitpointId: z.string(),
  status: WaitpointStatusSchema,
  feedback: z.string().optional(),
  // how long it waited for the answer
  waitedMs: z.number().optional(),
  expiresAt: IsoDateTimeSchema,
};

// The card in the reply: pending while it waits, then how it was answered ("Plan approved ✓ · 1m 16s").
export const WaitpointBlockSchema = z.discriminatedUnion("waitpointType", [
  z.object({ ...WaitpointBlockCommon, waitpointType: z.literal("plan"), payload: PlanPayloadSchema }),
  z.object({ ...WaitpointBlockCommon, waitpointType: z.literal("credit"), payload: CreditPayloadSchema }),
]);

export type WaitpointType = z.infer<typeof WaitpointTypeSchema>;
export type WaitpointStatus = z.infer<typeof WaitpointStatusSchema>;
export type WaitpointAction = z.infer<typeof WaitpointActionSchema>;
export type PlanPayload = z.infer<typeof PlanPayloadSchema>;
export type CreditPayload = z.infer<typeof CreditPayloadSchema>;
export type Waitpoint = z.infer<typeof WaitpointSchema>;
export type RespondWaitpointBody = z.infer<typeof RespondWaitpointBodySchema>;
export type RespondWaitpointResponse = z.infer<typeof RespondWaitpointResponseSchema>;
export type WaitpointBlock = z.infer<typeof WaitpointBlockSchema>;
