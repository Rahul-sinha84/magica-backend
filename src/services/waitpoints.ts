import { WAITPOINT_ACTIONS, type RespondWaitpointBody, type Waitpoint } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import type { Waitpoint as WaitpointRow } from "#src/generated/prisma/client.js";
import { AppError } from "#src/lib/errors.js";
import { logger } from "#src/lib/logger.js";
import { toJson } from "#src/services/runs.js";
import { serializeWaitpoint, STATUS_FOR_ACTION, typeOf, WAITPOINT_KINDS, type StoredAnswer } from "#src/waitpoints/types.js";

// Answering a waitpoint. The row is locked while the waiting run is woken, so two answers at once, an answer racing the
// expiry, or an answer racing a stop all come out one way: the first to take the lock decides, and the rest see it.

const notFound = () => new AppError("NOT_FOUND", "That approval isn't there any more.");
// waking the run must not hold the lock for long; the call itself times out sooner (see src/lib/trigger.ts)
const TRANSACTION_TIMEOUT_MS = 15_000;

export interface RespondDeps {
  completeToken: (tokenId: string, output: Record<string, unknown>) => Promise<void>;
  now?: Date;
}

/**
 * Answers the user's own waitpoint and wakes the run waiting on it. An answer to one that is already closed (answered,
 * expired, cancelled) changes nothing and returns it as it stands, so repeating a click is harmless. Only the owner may
 * answer (anyone else gets a 404, as if it didn't exist). If the run can't be woken, nothing is saved (503: try again).
 */
export async function respondToWaitpoint(userId: string, waitpointId: string, body: RespondWaitpointBody, { completeToken, now = new Date() }: RespondDeps): Promise<Waitpoint> {
  const row = await prisma.$transaction(
    async (tx) => {
      const [locked] = await tx.$queryRaw<WaitpointRow[]>`
        SELECT w.* FROM "Waitpoint" w JOIN "AgentRun" r ON r."id" = w."agentRunId"
        WHERE w."id" = ${waitpointId} AND r."userId" = ${userId}
        FOR UPDATE OF w`;
      if (!locked) throw notFound();
      const type = typeOf(locked.type);
      const allowed: readonly string[] = WAITPOINT_ACTIONS[type];
      if (!allowed.includes(body.action)) {
        throw new AppError("VALIDATION_FAILED", `action: ${WAITPOINT_KINDS[type].noun} can be answered with ${allowed.join(" or ")}.`, { fields: { action: ["not allowed for this waitpoint"] } });
      }
      if (body.action === "request_changes" && !body.feedback) {
        throw new AppError("VALIDATION_FAILED", "feedback: Say what you'd like changed.", { fields: { feedback: ["required with request_changes"] } });
      }
      if (locked.status !== "PENDING") return locked; // already closed: as it stands

      if (locked.expiresAt.getTime() <= now.getTime()) {
        // too late: the run wakes on its own (the token has timed out) and finds it expired
        return tx.waitpoint.update({ where: { id: locked.id }, data: { status: "EXPIRED", resolvedAt: now } });
      }
      const answer: StoredAnswer = { action: body.action, ...(body.feedback !== undefined && { feedback: body.feedback }) };
      try {
        await completeToken(locked.triggerTokenId, { ...answer });
      } catch (err) {
        logger.warn({ err, waitpointId }, "could not wake the run waiting on the waitpoint");
        throw new AppError("SERVICE_UNAVAILABLE", "We couldn't send your answer right now. Try again in a moment.");
      }
      // If this save is lost after the run was woken, the run finds the answer in its token and saves it itself.
      return tx.waitpoint.update({ where: { id: locked.id }, data: { status: STATUS_FOR_ACTION[body.action], response: toJson(answer), resolvedAt: now } });
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  );
  return serializeWaitpoint(row);
}

/** The question the run is waiting on, if any. */
export async function pendingWaitpoint(runId: string): Promise<Waitpoint | null> {
  const row = await prisma.waitpoint.findFirst({ where: { agentRunId: runId, status: "PENDING" } });
  return row ? serializeWaitpoint(row) : null;
}
