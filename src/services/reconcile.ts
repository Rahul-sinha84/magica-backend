import { cancelTriggerRun, getTriggerRunStatus } from "#src/lib/trigger.js";
import { logger } from "#src/lib/logger.js";
import { prisma } from "#src/db/client.js";
import { ACTIVE_STATUSES, finalizeRun, findActiveRun, type ActiveRun, type RunOutcome } from "#src/services/runs.js";

// A run can be left "active" if a worker dies or a step is lost. Nothing is allowed to stay locked forever: these
// rules find such runs and end them through the same `finalizeRun` as everything else.

const DISPATCH_GRACE_MS = 60_000; // a run that was never handed to Trigger.dev
// A run the task never picked up (no worker deployed or running, a missing version) would otherwise hold the chat for
// the full time limit. Generous, because a busy queue can make a healthy run wait.
export const START_TIMEOUT_MS = 3 * 60_000;
const QUIET_MS = 30_000; // no partial reply saved for this long: worth asking Trigger.dev what happened
export const MAX_RUN_MS = 11 * 60_000; // the task's maxDuration (10 minutes) plus slack: nothing legitimate lives longer
const LOOKUP_EVERY_MS = 15_000; // at most one Trigger.dev lookup per run in this window, however often it is polled

const lastLookup = new Map<string, number>();

const failed = (errorCode: string, errorMessage: string): RunOutcome => ({ status: "FAILED", errorCode, errorMessage });

/** What a run that Trigger.dev reports as over means for ours, which only gets here if ours never finished itself. */
const ENDED_AS: Readonly<Record<string, RunOutcome>> = {
  CANCELED: { status: "CANCELLED" },
  COMPLETED: failed("RESULT_LOST", "The reply was generated but couldn't be saved. Please try again."),
  FAILED: failed("AGENT_FAILED", "The agent ran into a problem. Please try again."),
  CRASHED: failed("AGENT_CRASHED", "The agent stopped unexpectedly. Please try again."),
  SYSTEM_FAILURE: failed("AGENT_CRASHED", "The agent stopped unexpectedly. Please try again."),
  TIMED_OUT: failed("AGENT_TIMEOUT", "The agent took too long. Please try again."),
  EXPIRED: failed("AGENT_EXPIRED", "The agent couldn't start in time. Please try again."),
};

export interface ReconcileOptions {
  /** Ask Trigger.dev even if the run looks healthy (used when something is actually blocked by it). */
  force?: boolean;
  now?: number;
}

/**
 * Ends the run if it is dead. Returns true when the run is no longer active, whether this call ended it or another
 * request got there first, so the caller can carry on as if the slot were free.
 */
export async function reconcileRun(run: ActiveRun, { force = false, now = Date.now() }: ReconcileOptions = {}): Promise<boolean> {
  const age = now - run.createdAt.getTime();
  // resolves to whether THIS call ended the run (false means it had already ended, which the caller treats the same way)
  const end = async (outcome: RunOutcome) => {
    lastLookup.delete(run.id);
    const ours = await finalizeRun(run.id, outcome);
    if (ours) logger.warn({ runId: run.id, chatId: run.chatId, outcome: outcome.status, errorCode: outcome.errorCode }, "ended a stale run");
    return ours;
  };

  if (!run.triggerRunId) {
    if (age < DISPATCH_GRACE_MS) return false;
    await end(failed("DISPATCH_LOST", "The agent couldn't be started. Please try again."));
    return true;
  }

  const quiet = now - Math.max(run.assistantMessage.updatedAt.getTime(), run.createdAt.getTime()) >= QUIET_MS;
  const due = force || quiet || age >= MAX_RUN_MS;
  if (due && (force || now - (lastLookup.get(run.id) ?? 0) >= LOOKUP_EVERY_MS)) {
    if (lastLookup.size > 10_000) lastLookup.clear();
    lastLookup.set(run.id, now);
    const status = await getTriggerRunStatus(run.triggerRunId);
    const outcome = status ? ENDED_AS[status] : undefined;
    if (outcome) {
      await end(outcome);
      return true;
    }
  }

  // still waiting for the task to pick it up after all this time: nothing is running it, so say so instead of waiting on
  if (run.status === "PENDING" && age >= START_TIMEOUT_MS) {
    const ours = await end(failed("AGENT_NOT_STARTED", "The agent isn't running right now. Please try again in a moment."));
    // take it off the queue too, so it cannot start later against a turn that is already over
    if (ours) await cancelTriggerRun(run.triggerRunId);
    return true;
  }

  // whatever Trigger.dev says (or cannot say), nothing is allowed to outlive the task's own time limit
  if (age >= MAX_RUN_MS) {
    await end(failed("AGENT_TIMEOUT", "The agent took too long. Please try again."));
    return true;
  }
  return false;
}

/** Looks for the chat's active run and reconciles it. */
export async function reconcileChat(chatId: string, options?: ReconcileOptions): Promise<boolean> {
  const run = await findActiveRun(chatId);
  return run ? reconcileRun(run, options) : false;
}

/**
 * Credits held by a run that is really dead must not make a new send look unaffordable. Called when a hold is refused:
 * looks at this user's other runs that have been going a while, ends the dead ones, and says whether any credits came
 * back. (Bounded, and only on this failure path, so a busy user costs nothing extra.)
 */
export async function reconcileUserRuns(userId: string, options?: ReconcileOptions): Promise<boolean> {
  const candidates = await prisma.agentRun.findMany({
    where: { userId, status: { in: [...ACTIVE_STATUSES] }, createdAt: { lt: new Date((options?.now ?? Date.now()) - QUIET_MS) } },
    include: { assistantMessage: { select: { updatedAt: true, contentBlocks: true } } },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  let freed = false;
  for (const run of candidates) freed = (await reconcileRun(run, { ...options, force: true })) || freed;
  return freed;
}
