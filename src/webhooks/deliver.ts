import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { prisma } from "#src/db/client.js";
import { decryptSecret, signWebhook } from "#src/lib/webhookSigning.js";
import { safeLookup } from "#src/lib/webhookUrl.js";

// Sends one recorded delivery: signed (Svix's scheme), at most 10 seconds, never following a redirect, and only to a
// public address (checked on the address actually connected to). A 2xx answer delivers it; anything else records why
// and throws, so the deliver-webhook task retries it with backoff. A delivery already sent is never sent again.

export const DELIVERY_TIMEOUT_MS = 10_000;
const USER_AGENT = "MagicaClone-Webhooks/1";

export class DeliveryFailed extends Error {}

export interface DeliveryOptions {
  /** WEBHOOK_SECRET_KEY: decrypts the endpoint's signing secret */
  keyHex: string;
  /** development only: http://localhost receivers */
  allowLocalhost: boolean;
  timeoutMs?: number;
  now?: () => number;
}

const isLocal = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1";

/** POSTs the body; resolves with the status code. Rejects on a network error, a refused address or the timeout. */
function post(url: URL, body: string, headers: Record<string, string>, timeoutMs: number, allowLocalhost: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      url,
      { method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, lookup: safeLookup((host) => allowLocalhost && isLocal(host)), timeout: timeoutMs },
      (res) => {
        res.resume(); // the answer's body doesn't matter
        res.on("end", () => resolve(res.statusCode ?? 0));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`no answer within ${timeoutMs / 1000} seconds`)));
    req.on("error", reject);
    req.end(body);
  });
}

/** Delivers it (or does nothing if it was already delivered, given up on, or deleted). Throws DeliveryFailed to retry. */
export async function deliverWebhook(deliveryId: string, { keyHex, allowLocalhost, timeoutMs = DELIVERY_TIMEOUT_MS, now = Date.now }: DeliveryOptions): Promise<"delivered" | "skipped"> {
  const delivery = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { subscription: { include: { endpoint: true } } } });
  if (!delivery || delivery.status !== "PENDING") return "skipped";
  const { endpoint } = delivery.subscription;
  const url = new URL(endpoint.url);
  if (url.protocol !== "https:" && !(allowLocalhost && url.protocol === "http:" && isLocal(url.hostname))) {
    throw new DeliveryFailed("the endpoint must use https");
  }

  const body = JSON.stringify(delivery.payload);
  const id = `msg_${delivery.id}`; // the same on every attempt, so a receiver can tell a retry from a new event
  const timestamp = Math.floor(now() / 1000);
  const headers = {
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    "svix-id": id,
    "svix-timestamp": String(timestamp),
    "svix-signature": signWebhook(decryptSecret(endpoint.secretEncrypted, keyHex), id, timestamp, body),
  };
  await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { attempts: { increment: 1 } } });

  let problem: string;
  try {
    const status = await post(url, body, headers, timeoutMs, allowLocalhost);
    if (status >= 200 && status < 300) {
      await prisma.webhookDelivery.updateMany({ where: { id: delivery.id, status: "PENDING" }, data: { status: "DELIVERED", deliveredAt: new Date(now()), lastError: null } });
      return "delivered";
    }
    problem = status >= 300 && status < 400 ? `answered HTTP ${status} (redirects aren't followed)` : `answered HTTP ${status}`;
  } catch (error) {
    problem = error instanceof Error ? error.message : "the request failed";
  }
  await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { lastError: problem.slice(0, 500) } });
  throw new DeliveryFailed(problem);
}

/** Gives up on a delivery after its last attempt. */
export async function giveUpDelivery(deliveryId: string, reason?: string): Promise<void> {
  await prisma.webhookDelivery.updateMany({ where: { id: deliveryId, status: "PENDING" }, data: { status: "FAILED", ...(reason && { lastError: reason.slice(0, 500) }) } });
}
