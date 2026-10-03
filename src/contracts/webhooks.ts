import { z } from "zod";
import { IsoDateTimeSchema } from "./common.js";

// Outbound webhooks, as the reference does them: pass `webhook` when starting work on /v1, and signed events are sent to
// your URL as the work progresses. Signatures follow Svix's scheme (svix-id, svix-timestamp and svix-signature
// headers), so the `svix` package verifies them with the `whsec_…` secret returned when you register.

export const WEBHOOK_EVENTS = ["agent.started", "agent.completed", "agent.failed", "agent.canceled", "tool.completed", "tool.failed"] as const;
export const WebhookEventTypeSchema = z.enum(WEBHOOK_EVENTS);

/** At most this much metadata (as JSON) is echoed back on each event. */
export const WEBHOOK_METADATA_MAX_BYTES = 4096;

// `events` defaults to all of them. `metadata` is echoed back on every event. The URL must be public https.
export const WebhookRequestSchema = z.strictObject({
  url: z.string().trim().min(1).max(2048),
  events: z
    .array(WebhookEventTypeSchema)
    .min(1)
    .refine((events) => new Set(events).size === events.length, { error: "Each event can be listed once." })
    .optional(),
  metadata: z
    .record(z.string(), z.unknown())
    .refine((metadata) => new TextEncoder().encode(JSON.stringify(metadata)).length <= WEBHOOK_METADATA_MAX_BYTES, { error: `Metadata can be at most ${WEBHOOK_METADATA_MAX_BYTES} bytes of JSON.` })
    .optional(),
});

// Returned when a webhook is registered. The same URL always gets the same secret: store it to verify deliveries.
export const WebhookRegisteredSchema = z.object({ signingSecret: z.string().startsWith("whsec_") });

// What every delivery's body is. `runId` is the agent run (or the standalone tool run) it is about.
export const WebhookEventSchema = z.object({
  success: z.boolean(),
  type: WebhookEventTypeSchema,
  runId: z.string(),
  data: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});

export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;
export type WebhookRequest = z.infer<typeof WebhookRequestSchema>;
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;
