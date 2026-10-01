import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as TriggerClient from "#src/lib/trigger.js";

// The real src/lib/trigger.ts (the rest of the suite replaces it with a mock), with the Trigger.dev SDK faked.
const sdk = vi.hoisted(() => ({ trigger: vi.fn(), configure: vi.fn() }));
vi.mock("@trigger.dev/sdk", () => ({
  configure: sdk.configure,
  tasks: { trigger: sdk.trigger },
  runs: { cancel: vi.fn(), retrieve: vi.fn() },
  auth: { createPublicToken: vi.fn() },
}));

const { dispatchAgentTurn } = await vi.importActual<typeof TriggerClient>("#src/lib/trigger.js");
const { AGENT_QUEUE_TTL_SECONDS, AGENT_TASK_ID } = await import("#src/agent/payload.js");

const payload = { agentRunId: "run1", chatId: "chat1", userId: "user1", assistantMessageId: "msg1", traceId: "trace1" };

beforeEach(() => sdk.trigger.mockReset().mockResolvedValue({ id: "run_trigger_1" }));

describe("dispatchAgentTurn", () => {
  it("starts the agent task with the run's idempotency key and a queue time-to-live", async () => {
    expect(await dispatchAgentTurn(payload, "agent-run:run1")).toBe("run_trigger_1");
    expect(sdk.trigger).toHaveBeenCalledWith(AGENT_TASK_ID, payload, expect.objectContaining({ idempotencyKey: "agent-run:run1", ttl: AGENT_QUEUE_TTL_SECONDS }));
  });

  it("drops a turn nobody starts within 10 minutes", () => {
    expect(AGENT_QUEUE_TTL_SECONDS).toBe(600);
  });
});
