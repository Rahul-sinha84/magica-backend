import type { Logger } from "pino";
import type { AssetBlock } from "#src/tools/registry.js";
import { prisma } from "#src/db/client.js";
import { MagicaError, type MagicaClient } from "#src/lib/magica.js";
import { completeInvocation, endInvocation, markDispatching, markRunning } from "#src/services/toolInvocations.js";
import { callMagicaTool } from "#src/tools/magicaTools.js";
import type { ToolRegistry } from "#src/tools/registry.js";

// One Magica tool call, run durably (inside a Trigger.dev child task). It can be repeated safely: a call that already
// finished answers from what was saved, a call whose Magica run was started resumes that run, and a call that may or
// may not have reached Magica is never sent again (Magica has no idempotency key, so a second POST is a second paid
// run). Every ending goes through the invocation service, which charges or releases credits exactly once.

export type InvocationOutcome =
  | { status: "COMPLETED"; output: unknown; assets: AssetBlock[]; durationMs: number }
  | { status: "FAILED" | "CANCELLED"; message: string };

export interface InvocationDeps {
  client: MagicaClient;
  registry: ToolRegistry;
  log: Logger;
  signal?: AbortSignal;
  db?: typeof prisma;
  now?: () => number;
  maxWaitMs?: number;
}

const UNCONFIRMED = "We couldn't confirm whether this finished, so nothing was charged. Please try again.";
const STOPPED = "Stopped.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Saving a finished call is the one write that must not be lost to a passing database problem. */
async function withRetries<T>(work: () => Promise<T>, log: Logger, what: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= 3) throw error;
      log.warn({ err: error, attempt }, `could not ${what}; trying again`);
      await sleep(100 * attempt);
    }
  }
}

export async function runMagicaInvocation(invocationId: string, deps: InvocationDeps): Promise<InvocationOutcome> {
  const { client, registry, log, signal, db = prisma, now = Date.now, maxWaitMs } = deps;
  const end = async (status: "FAILED" | "CANCELLED", message: string): Promise<InvocationOutcome> => {
    await withRetries(() => endInvocation(invocationId, status, message, db), log, "end the tool call");
    return { status, message };
  };

  const invocation = await db.toolInvocation.findUnique({ where: { id: invocationId } });
  if (!invocation) return { status: "FAILED", message: "This tool call no longer exists." }; // its chat was deleted
  const tool = registry.get(invocation.toolName);
  if (!tool?.magica) return end("FAILED", `Unknown tool: ${invocation.toolName}`);

  // already over: answer from what was saved
  if (invocation.status === "COMPLETED") {
    const output = tool.output.safeParse(invocation.output);
    const savedInput = tool.input.safeParse(invocation.input);
    if (output.success) return { status: "COMPLETED", output: output.data, assets: tool.assets?.(output.data, savedInput.success ? savedInput.data : undefined) ?? [], durationMs: invocation.durationMs ?? 0 };
    return { status: "FAILED", message: `${tool.magica.label} returned an unexpected result.` };
  }
  if (invocation.status === "FAILED" || invocation.status === "CANCELLED") return { status: invocation.status, message: invocation.errorMessage ?? STOPPED };

  // sent before, but its run id was never saved: it may be running (and billed) at Magica, so it must not be sent again
  if (invocation.status !== "PENDING" && !invocation.magicaRunId) {
    log.warn({ invocationId, status: invocation.status }, "tool call was dispatched but its outcome is unknown; not sending it again");
    return end("FAILED", UNCONFIRMED);
  }

  const input = tool.input.safeParse(invocation.input);
  if (!input.success) return end("FAILED", `Invalid input for ${tool.name}.`);

  let dispatchedAt = invocation.dispatchedAt?.getTime() ?? null;
  let savedRunId = invocation.magicaRunId;
  let pendingRunId: string | null = null;
  const saveRunId = async () => {
    if (!pendingRunId || savedRunId === pendingRunId) return;
    if (await markRunning(invocationId, pendingRunId, db)) savedRunId = pendingRunId;
  };

  let result;
  try {
    result = await callMagicaTool(tool, input.data, client, {
      ...(signal && { signal }),
      ...(maxWaitMs !== undefined && { maxWaitMs }),
      ...(invocation.magicaRunId && { resumeRunId: invocation.magicaRunId }),
      beforeStart: async () => {
        // the input passed the live schema: mark it sent BEFORE sending, so a crash after this is never resent
        if (!(await markDispatching(invocationId, db))) throw new AlreadyTaken();
        dispatchedAt = now();
      },
      onStarted: async (runId) => {
        pendingRunId = runId;
        try {
          await saveRunId();
        } catch (error) {
          log.warn({ err: error, invocationId }, "could not save the Magica run id yet; will retry while waiting");
        }
      },
      // keep trying to save the run id while waiting (a database blip must not lose track of a paid run)
      onStatus: () => saveRunId(),
      onStatusError: (error) => log.warn({ err: error, invocationId }, "could not save tool call progress"),
    });
  } catch (error) {
    if (error instanceof AlreadyTaken) {
      log.warn({ invocationId }, "tool call is already being run by another attempt");
      return { status: "FAILED", message: "This tool call is already running." };
    }
    if (signal?.aborted) return end("CANCELLED", STOPPED);
    if (error instanceof MagicaError) {
      log.warn({ invocationId, failure: error.failure, detail: error.detail, outcomeUnknown: error.outcomeUnknown }, "Magica tool call failed");
      return end("FAILED", error.outcomeUnknown ? UNCONFIRMED : error.message);
    }
    log.error({ err: error, invocationId }, "Magica tool call failed unexpectedly");
    return end("FAILED", `${tool.magica.label} failed. Please try again.`);
  }

  const output = tool.output.safeParse(result.output);
  if (!output.success) {
    log.error({ invocationId, issues: output.error.issues.slice(0, 5) }, "Magica tool returned an output that doesn't match the tool's contract");
    return end("FAILED", `${tool.magica.label} returned an unexpected result.`);
  }
  const durationMs = dispatchedAt === null ? 0 : now() - dispatchedAt;
  const assets = tool.assets?.(output.data, input.data) ?? [];
  const settled = await withRetries(() => completeInvocation(invocationId, { output: output.data, durationMs, providerCost: result.run.creditUsed ?? null, assets }, db), log, "save the finished tool call");
  if (!settled) {
    // Nothing changed: either the call was ended meanwhile (stopped: not charged, result not used), or an earlier save
    // attempt did commit and only its reply was lost (completed and charged). Report what the database says.
    const current = await db.toolInvocation.findUnique({ where: { id: invocationId }, select: { status: true, errorMessage: true, durationMs: true } });
    if (current?.status === "COMPLETED") return { status: "COMPLETED", output: output.data, assets, durationMs: current.durationMs ?? durationMs };
    return { status: current?.status === "FAILED" ? "FAILED" : "CANCELLED", message: current?.errorMessage ?? STOPPED };
  }
  log.info({ invocationId, tool: tool.name, durationMs, providerCost: result.run.creditUsed }, "tool call completed");
  return { status: "COMPLETED", output: output.data, assets, durationMs };
}

class AlreadyTaken extends Error {}
