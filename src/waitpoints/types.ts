import type { z } from "zod";
import { CreditPayloadSchema, PlanPayloadSchema, WAITPOINT_ACTIONS, WaitpointSchema, type Waitpoint, type WaitpointAction, type WaitpointStatus, type WaitpointType } from "#src/contracts/index.js";
import type { Waitpoint as WaitpointRow } from "#src/generated/prisma/client.js";

// The kinds of waitpoint and what each allows. Shared by the API (answering) and the worker (waiting), so it imports
// nothing that only one of them configures. A new kind is a new entry here (and its payload in the contract).

type DbType = WaitpointRow["type"];
type DbStatus = WaitpointRow["status"];

interface WaitpointKind {
  db: DbType;
  payload: z.ZodType;
  actions: readonly WaitpointAction[];
  /** what this kind is called in messages */
  noun: string;
}

export const WAITPOINT_KINDS: Readonly<Record<WaitpointType, WaitpointKind>> = {
  plan: { db: "PLAN", payload: PlanPayloadSchema, actions: WAITPOINT_ACTIONS.plan, noun: "A plan" },
  credit: { db: "CREDIT", payload: CreditPayloadSchema, actions: WAITPOINT_ACTIONS.credit, noun: "A spend approval" },
};

export const typeOf = (db: DbType): WaitpointType => (db === "PLAN" ? "plan" : "credit");

/** What each answer makes of the waitpoint. */
export const STATUS_FOR_ACTION = { approve: "APPROVED", request_changes: "CHANGES_REQUESTED", reject: "REJECTED" } as const satisfies Record<WaitpointAction, DbStatus>;

export const statusOf = (db: DbStatus): WaitpointStatus => db.toLowerCase() as WaitpointStatus;

/** The answer as it is stored on the row and sent to the waiting run (the token's output). */
export interface StoredAnswer {
  action: WaitpointAction;
  feedback?: string;
}

/** The stored answer, if the row (or a token's output) holds a valid one for this kind. */
export function readAnswer(type: WaitpointType, value: unknown): StoredAnswer | null {
  if (!value || typeof value !== "object") return null;
  const { action, feedback } = value as Record<string, unknown>;
  if (typeof action !== "string" || !(WAITPOINT_KINDS[type].actions as readonly string[]).includes(action)) return null;
  if (feedback !== undefined && typeof feedback !== "string") return null;
  if (action === "request_changes" && !feedback?.trim()) return null;
  return { action: action as WaitpointAction, ...(feedback !== undefined && { feedback }) };
}

/** A waitpoint as the API shows it. */
export function serializeWaitpoint(row: WaitpointRow): Waitpoint {
  const type = typeOf(row.type);
  return WaitpointSchema.parse({
    id: row.id,
    runId: row.agentRunId,
    type,
    status: statusOf(row.status),
    payload: row.payload,
    feedback: readAnswer(type, row.response)?.feedback ?? null,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  });
}
