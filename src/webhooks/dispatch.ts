import { tasks } from "@trigger.dev/sdk";
import { logger } from "#src/lib/logger.js";

// Hands recorded deliveries to the deliver-webhook task. Best effort: a delivery whose task couldn't be started is
// still in the outbox, and the sweeper (src/trigger/webhookSweeper.ts) starts it later. Replaced in tests.

export const DELIVER_WEBHOOK_TASK_ID = "deliver-webhook";

export async function dispatchWebhookDeliveries(deliveryIds: readonly string[]): Promise<void> {
  for (const deliveryId of deliveryIds) {
    try {
      await tasks.trigger(DELIVER_WEBHOOK_TASK_ID, { deliveryId }, { idempotencyKey: `webhook:${deliveryId}`, tags: ["webhook"] });
    } catch (err) {
      logger.warn({ err, deliveryId }, "could not start a webhook delivery; the sweeper will retry it");
    }
  }
}
