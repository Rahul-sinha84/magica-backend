import { AGENT_QUEUE_TTL_SECONDS } from "#src/agent/payload.js";
import { cancelTriggerRun, getTriggerRunStatus } from "#src/lib/trigger.js";
import { logger } from "#src/lib/logger.js";
import { prisma } from "#src/db/client.js";
import { ACTIVE_STATUSES, finalizeRun, findActiveRun, WAITPOINT_EXPIRED, type ActiveRun, type RunOutcome } from "#src/services/runs.js";

// A run can be left "active" if a worker dies or a step is lost. Nothing is allowed to stay locked forever: these
// rules find such runs and end them through the same `finalizeRun` as everything else.

const DISPATCH_GRACE_MS = 60_000; // a run that was never handed to Trigger.dev
// Waiting in Trigger.dev's queue is normal when many turns arrive at once, so a pending run is never ended just for
// waiting. Only a run that no worker can ever take (Trigger.dev reports PENDING_VERSION: the task is not deployed)
// is ended early, after this long.
export const START_TIMEOUT_MS = 3 * 60_000;
// Trigger.dev drops a turn that waited longer than its queue TTL; past that (plus slack), a run still pending here was
// never started, even if Trigger.dev cannot be asked.
export const QUEUE_LIMIT_MS = AGENT_QUEUE_TTL_SECONDS * 1_000 + 60_000;
const QUIET_MS = 30_000; // no partial reply saved for this long: worth asking Trigger.dev what happened
// Counted from when the worker started the run, not from the send, so time spent waiting in the queue does not count:
// the task's maxDuration (10 minutes) plus slack. Nothing legitimate runs longer.
export const MAX_RUN_MS = 11 * 60_000;
// Waiting for a tool (a Magica job runs as a child task) doesn't count against the agent task's time limit, so a turn
// using tools can legitimately run longer. While a tool call is in flight, the limit is that call's own: the Magica
// tool task's maxDuration (7 minutes) plus slack, counted from when the call was made.
export const TOOL_CALL_LIMIT_MS = 8 * 60_000;
// Waiting for the user's answer doesn't count either: a waiting run is healthy until its waitpoint expires, plus this
// long for the run to wake and end itself.
export const WAITPOINT_SLACK_MS = 2 * 60_000;
const LOOKUP_EVERY_MS = 15_000; // at most one Trigger.dev lookup per run in this window, however often it is polled

// the last answer Trigger.dev gave about each run, so a poll between lookups still knows what it said
const lastLookup = new Map<string, { at: number; status: string | null }>();

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

  const pending = run.status === "PENDING";
  const runningFor = pending ? 0 : now - (run.startedAt ?? run.createdAt).getTime();
  const overLimit = pending ? age >= QUEUE_LIMIT_MS : runningFor >= MAX_RUN_MS;
  const quiet = now - Math.max(run.assistantMessage.updatedAt.getTime(), run.createdAt.getTime()) >= QUIET_MS;
  const due = force || quiet || overLimit;
  let known = lastLookup.get(run.id);
  if (due && (force || now - (known?.at ?? 0) >= LOOKUP_EVERY_MS)) {
    if (lastLookup.size > 10_000) lastLookup.clear();
    known = { at: now, status: await getTriggerRunStatus(run.triggerRunId) };
    lastLookup.set(run.id, known);
    const outcome = known.status ? ENDED_AS[known.status] : undefined;
    if (outcome) {
      await end(outcome);
      return true;
    }
  }

  if (pending) {
    // No worker can take it (the task is not deployed), or it has waited past the point where Trigger.dev would have
    // dropped it: it will never start, so say so instead of leaving the chat locked.
    const noWorker = known?.status === "PENDING_VERSION" && age >= START_TIMEOUT_MS;
    if (!noWorker && !overLimit) return false; // just waiting its turn in the queue
    const ours = await end(failed("AGENT_NOT_STARTED", "The agent isn't running right now. Please try again in a moment."));
    // take it off the queue too, so it cannot start later against a turn that is already over
    if (ours) await cancelTriggerRun(run.triggerRunId);
    return true;
  }

  // whatever Trigger.dev says (or cannot say), nothing is allowed to outlive the task's own time limit, except while it
  // waits (for a tool call or the user's answer) within that wait's own limit
  const overrun = overLimit ? await overrunOutcome(run.id, now) : null;
  if (overrun) {
    await end(overrun);
    return true;
  }
  return false;
}

/**
 * For a run past MAX_RUN_MS since it started: how it should end, or null if it is still legitimately going. Waits
 * don't count against the task's time limit, so it is fine while it waits for a tool call or for the user's answer
 * (until the waitpoint expires), and for MAX_RUN_MS after it last resumed from one.
 */
async function overrunOutcome(runId: string, now: number): Promise<RunOutcome | null> {
  if (await waitingOnATool(runId, now)) return null;
  const waitpoint = await prisma.waitpoint.findFirst({ where: { agentRunId: runId }, orderBy: { createdAt: "desc" }, select: { status: true, expiresAt: true, resolvedAt: true } });
  if (waitpoint?.status === "PENDING") {
    return now < waitpoint.expiresAt.getTime() + WAITPOINT_SLACK_MS ? null : failed(WAITPOINT_EXPIRED.code, WAITPOINT_EXPIRED.message);
  }
  const tool = await prisma.toolInvocation.findFirst({ where: { agentRunId: runId, completedAt: { not: null } }, orderBy: { completedAt: "desc" }, select: { completedAt: true } });
  const resumedAt = Math.max(waitpoint?.resolvedAt?.getTime() ?? 0, tool?.completedAt?.getTime() ?? 0);
  return now - resumedAt < MAX_RUN_MS ? null : failed("AGENT_TIMEOUT", "The agent took too long. Please try again.");
}

/** True while the run has a tool call in flight that is still within the tool call's own time limit. */
async function waitingOnATool(runId: string, now: number): Promise<boolean> {
  const latest = await prisma.toolInvocation.findFirst({
    where: { agentRunId: runId, status: { in: ["PENDING", "DISPATCHING", "RUNNING"] } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, dispatchedAt: true },
  });
  if (!latest) return false;
  return now - (latest.dispatchedAt ?? latest.createdAt).getTime() < TOOL_CALL_LIMIT_MS;
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
