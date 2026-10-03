import { vi } from "vitest";

// Stands in for src/webhooks/dispatch.ts: records which deliveries would have been handed to the deliver-webhook task.
export const webhooks = { dispatched: [] as string[] };

export function resetWebhookMock() {
  webhooks.dispatched.length = 0;
}

export const dispatchModule = {
  DELIVER_WEBHOOK_TASK_ID: "deliver-webhook",
  dispatchWebhookDeliveries: vi.fn((ids: readonly string[]) => {
    webhooks.dispatched.push(...ids);
    return Promise.resolve();
  }),
};
