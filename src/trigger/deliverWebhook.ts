import { schedules, task } from "@trigger.dev/sdk";
import { prisma } from "#src/db/client.js";
import { env } from "#src/env/worker.js";
import { logger } from "#src/lib/logger.js";
import { deliverWebhook, giveUpDelivery } from "#src/webhooks/deliver.js";
import { DELIVER_WEBHOOK_TASK_ID, dispatchWebhookDeliveries } from "#src/webhooks/dispatch.js";

// Sends one webhook delivery, retrying with backoff (about 1 + 2 + 4 + 8 + 16 minutes) until the receiver answers 2xx;
// after the last attempt it is marked failed. One task per delivery (its idempotency key), and a delivered one is
// never sent again, so a duplicated event can't be delivered twice.

export const deliverWebhookTask = task({
  id: DELIVER_WEBHOOK_TASK_ID,
  maxDuration: 60,
  retry: { maxAttempts: 6, factor: 2, minTimeoutInMs: 60_000, maxTimeoutInMs: 16 * 60_000, randomize: true },
  run: async ({ deliveryId }: { deliveryId: string }) => {
    if (!env.WEBHOOK_SECRET_KEY) {
      await giveUpDelivery(deliveryId, "Webhooks aren't configured on the worker (WEBHOOK_SECRET_KEY).");
      return { result: "not-configured" as const };
    }
    const result = await deliverWebhook(deliveryId, { keyHex: env.WEBHOOK_SECRET_KEY, allowLocalhost: env.NODE_ENV !== "production" });
    logger.info({ deliveryId, result }, "webhook delivery");
    return { result };
  },
  onFailure: async ({ payload }: { payload: { deliveryId: string } }) => {
    await giveUpDelivery(payload.deliveryId);
  },
});

// The outbox's safety net: deliveries recorded but never handed to a task (Trigger.dev was unreachable at that
// moment, or the event was recorded inside another transaction) are started here. Their idempotency key keeps this
// from ever starting one twice.
const STALE_MS = 2 * 60_000;

export const webhookSweeper = schedules.task({
  id: "webhook-sweeper",
  cron: "*/5 * * * *",
  maxDuration: 120,
  run: async () => {
    const stale = await prisma.webhookDelivery.findMany({
      where: { status: "PENDING", attempts: 0, createdAt: { lt: new Date(Date.now() - STALE_MS) } },
      orderBy: { createdAt: "asc" },
      take: 200,
      select: { id: true },
    });
    if (stale.length > 0) {
      logger.info({ count: stale.length }, "starting webhook deliveries that were never started");
      await dispatchWebhookDeliveries(stale.map((delivery) => delivery.id));
    }
    return { started: stale.length };
  },
});
