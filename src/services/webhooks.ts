import type { WebhookRequest } from "#src/contracts/index.js";
import { prisma, Prisma } from "#src/db/client.js";
import { env } from "#src/env/server.js";
import { AppError } from "#src/lib/errors.js";
import { decryptSecret, encryptSecret, generateSigningSecret } from "#src/lib/webhookSigning.js";
import { resolvesPublicly, webhookUrlProblem } from "#src/lib/webhookUrl.js";
import { ALL_WEBHOOK_EVENTS } from "#src/webhooks/events.js";

// Registering webhooks on /v1 starts. A destination (user and URL) keeps one signing secret, so registering the same
// URL again gives the same secret back, as the reference does; it is stored encrypted and never logged.

type Tx = Prisma.TransactionClient;

/** What a start passes on: the endpoint to send to, and the subscription's events and metadata. */
export interface WebhookTarget {
  endpointId: string;
  events: readonly string[];
  metadata: Record<string, unknown> | null;
}

const invalid = (message: string) => new AppError("VALIDATION_FAILED", `webhook.url: ${message}.`, { fields: { "webhook.url": [message] } });
// a receiver on this machine is fine while developing, never in production
const allowLocalhost = () => env.NODE_ENV !== "production";

/**
 * Checks the URL (public https; resolved now, and again on every delivery) and returns its endpoint and signing
 * secret, creating them the first time this user registers the URL.
 */
export async function registerWebhook(userId: string, request: WebhookRequest): Promise<{ target: WebhookTarget; signingSecret: string }> {
  const key = env.WEBHOOK_SECRET_KEY;
  if (!key) throw new AppError("SERVICE_UNAVAILABLE", "Webhooks aren't available right now.");
  const url = request.url;
  const problem = webhookUrlProblem(url, { allowLocalhost: allowLocalhost() });
  if (problem) throw invalid(problem);
  const { hostname } = new URL(url);
  const local = allowLocalhost() && (hostname === "localhost" || hostname === "127.0.0.1");
  if (!local && !(await resolvesPublicly(hostname.replace(/^\[|\]$/g, "")))) throw invalid("must resolve to a public address");

  const where = { userId_url: { userId, url } };
  let endpoint = await prisma.webhookEndpoint.findUnique({ where });
  if (!endpoint) {
    try {
      endpoint = await prisma.webhookEndpoint.create({ data: { userId, url, secretEncrypted: encryptSecret(generateSigningSecret(), key) } });
    } catch (error) {
      // the same URL registered at the same moment by a twin request: use that one
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
      endpoint = await prisma.webhookEndpoint.findUniqueOrThrow({ where });
    }
  }
  return {
    target: { endpointId: endpoint.id, events: request.events ?? ALL_WEBHOOK_EVENTS, metadata: request.metadata ?? null },
    signingSecret: decryptSecret(endpoint.secretEncrypted, key),
  };
}

/** Attaches a subscription to what was started (inside the transaction that starts it, so no event can be missed). */
export async function subscribe(tx: Tx, target: WebhookTarget, owner: { agentRunId: string } | { toolInvocationId: string }): Promise<void> {
  await tx.webhookSubscription.create({
    data: { endpointId: target.endpointId, events: [...target.events], ...(target.metadata && { metadata: target.metadata as Prisma.InputJsonValue }), ...owner },
  });
}
