import { z } from "zod";
import {
  ChatListQuerySchema,
  COMPLETIONS_MODEL,
  ChatListResponseSchema,
  CreditsResponseSchema,
  CropImageInputSchema,
  GptImage2InputSchema,
  IDEMPOTENCY_KEY_PATTERN,
  MediaListQuerySchema,
  MediaListResponseSchema,
  MergeVideosInputSchema,
  MessageListQuerySchema,
  MessageListResponseSchema,
  RespondWaitpointBodySchema,
  RespondWaitpointResponseSchema,
  V1ChatCompletionBodySchema,
  V1ChatCompletionPendingSchema,
  V1ChatCompletionSchema,
  V1ErrorResponseSchema,
  V1MessageAcceptedSchema,
  V1RunResponseSchema,
  V1SendMessageBodySchema,
  V1ToolRunAcceptedSchema,
  V1ToolRunResponseSchema,
  WEBHOOK_EVENTS,
  WebhookEventSchema,
  WebhookRegisteredSchema,
  WebhookRequestSchema,
} from "#src/contracts/index.js";

// The public API's OpenAPI 3.1 document, built from the same Zod contracts the server validates with, so the
// reference can't drift from the code. `pnpm docs:generate` writes it to docs/openapi.json; a test fails when that file is
// out of date. Only /v1 is described: /api is the app's own API.

type Json = Record<string, unknown>;

const jsonSchema = (schema: z.ZodType, io: "input" | "output"): Json => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: "any", target: "draft-2020-12" }) as Json;
  return rest;
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Json) => ({ "application/json": { schema } });

// Reusable bodies, named the way the reference reads them.
const COMPONENTS = {
  Error: [V1ErrorResponseSchema, "output"],
  SendMessageRequest: [V1SendMessageBodySchema, "input"],
  MessageAccepted: [V1MessageAcceptedSchema, "output"],
  ChatList: [ChatListResponseSchema, "output"],
  MessageList: [MessageListResponseSchema, "output"],
  RunResponse: [V1RunResponseSchema, "output"],
  RespondWaitpointRequest: [RespondWaitpointBodySchema, "input"],
  RespondWaitpointResponse: [RespondWaitpointResponseSchema, "output"],
  Credits: [CreditsResponseSchema, "output"],
  MediaList: [MediaListResponseSchema, "output"],
  GptImage2Input: [GptImage2InputSchema, "input"],
  CropImageInput: [CropImageInputSchema, "input"],
  MergeVideosInput: [MergeVideosInputSchema, "input"],
  ToolRunAccepted: [V1ToolRunAcceptedSchema, "output"],
  ToolRunResponse: [V1ToolRunResponseSchema, "output"],
  ChatCompletionRequest: [V1ChatCompletionBodySchema, "input"],
  ChatCompletion: [V1ChatCompletionSchema, "output"],
  ChatCompletionPending: [V1ChatCompletionPendingSchema, "output"],
  WebhookRequest: [WebhookRequestSchema, "input"],
  WebhookRegistered: [WebhookRegisteredSchema, "output"],
  WebhookEvent: [WebhookEventSchema, "output"],
} as const satisfies Record<string, readonly [z.ZodType, "input" | "output"]>;

const ERRORS: Record<string, string> = {
  "400": "The request isn't valid (`VALIDATION_FAILED`): `error` says which field and why.",
  "401": "No valid API key or session token (`UNAUTHORIZED`).",
  "402": "Not enough credits (`INSUFFICIENT_CREDITS`).",
  "404": "Not found, or not yours (`NOT_FOUND`).",
  "409": "A conflict: a run is already active in the chat (`RUN_ACTIVE`), or the Idempotency-Key was used differently (`IDEMPOTENCY_CONFLICT`).",
  "413": "The body is over 1 MB (`PAYLOAD_TOO_LARGE`).",
  "429": "A limit was reached (`RATE_LIMITED`): see `Retry-After` and `details`.",
  "503": "A service the request needs is unavailable right now (`SERVICE_UNAVAILABLE`): try again.",
};
const errors = (...codes: string[]) => Object.fromEntries(codes.map((code) => [code, { description: ERRORS[code], content: json(ref("Error")) }]));

const IDEMPOTENCY_HEADER = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  description:
    "Makes the request safe to repeat: the same key with the same body (within 24 hours) returns the first answer without doing the work again (`idempotent-replayed: true`); a different body, or a repeat while the first is still running, is a 409 `IDEMPOTENCY_CONFLICT`. A request that failed can be repeated with the same key.",
  schema: { type: "string", pattern: IDEMPOTENCY_KEY_PATTERN.source },
};

const pathId = (name: string, description: string) => ({ name, in: "path", required: true, description, schema: { type: "string" } });

/** Query parameters from a Zod object schema: one per field, required unless optional or defaulted. */
function query(schema: z.ZodObject): Json[] {
  const shape = jsonSchema(schema, "input") as { properties?: Record<string, Json>; required?: string[] };
  return Object.entries(shape.properties ?? {}).map(([name, property]) => ({ name, in: "query", required: (shape.required ?? []).includes(name), schema: property }));
}

const operation = (summary: string, description: string, extra: Json) => ({ summary, description, ...extra });

/**
 * The completion request as the reference reads it: `model` is the one model there is, and `tools` / `functions` (which
 * the server refuses, since the agent has its own tools) aren't offered. Other fields are accepted and ignored.
 */
function completionRequest(): Json {
  const schema = jsonSchema(V1ChatCompletionBodySchema, "input") as Json & { properties: Record<string, Json> };
  const { tools: _tools, functions: _functions, ...properties } = schema.properties;
  return { ...schema, properties: { ...properties, model: { type: "string", const: COMPLETIONS_MODEL, description: "The model: the free model router." } } };
}

const EVENT_DESCRIPTIONS: Record<(typeof WEBHOOK_EVENTS)[number], string> = {
  "agent.started": "The agent started working on the message.",
  "agent.completed": "The agent finished: `data` has the reply's id, the model and usage (tokens and credits).",
  "agent.failed": "The agent couldn't finish: `error` says why and `data.code` is the stable reason.",
  "agent.canceled": "The run was stopped.",
  "tool.completed": "A paid tool call finished (in a run, or a standalone tool run): `data` has its input, credits and what it made.",
  "tool.failed": "A paid tool call failed: `error` says why. Nothing was charged.",
};

const WEBHOOK_TITLES: Record<(typeof WEBHOOK_EVENTS)[number], string> = {
  "agent.started": "Agent started",
  "agent.completed": "Agent completed",
  "agent.failed": "Agent failed",
  "agent.canceled": "Agent canceled",
  "tool.completed": "Tool completed",
  "tool.failed": "Tool failed",
};

/** One webhook event as OpenAPI 3.1 describes webhooks: what we POST to your URL, and how to verify it. */
function webhookOperation(event: (typeof WEBHOOK_EVENTS)[number]): Json {
  const header = (name: string, description: string) => ({ name, in: "header", required: true, description, schema: { type: "string" } });
  return {
    post: {
      summary: WEBHOOK_TITLES[event],
      tags: ["Webhooks"],
      description: `\`${event}\`: ${EVENT_DESCRIPTIONS[event]} Verify the signature with the \`svix\` package and the \`whsec_…\` secret you were given; answer 2xx quickly (anything else is retried with backoff, about five times over half an hour), and treat a repeated \`svix-id\` as the same event.`,
      parameters: [
        header("svix-id", "The event's id: the same on every retry of it."),
        header("svix-timestamp", "When this attempt was sent (seconds since the epoch)."),
        header("svix-signature", "`v1,` and the base64 HMAC-SHA256 of `<svix-id>.<svix-timestamp>.<body>`."),
      ],
      requestBody: { required: true, content: json(ref("WebhookEvent")) },
      responses: { "2XX": { description: "Received." } },
    },
  };
}

export interface Server {
  url: string;
  description?: string;
}

export function buildOpenApi({ servers = [{ url: "http://localhost:3000" }] }: { servers?: Server[] } = {}): Json {
  const tool = (name: string, input: string, what: string) =>
    operation(`Run ${name}`, `${what} Runs on its own, without a chat, and is charged like the agent's calls: its estimate is reserved when it starts; if it completes, it is charged once, exactly what Magica reports it used, and the rest is given back; otherwise all of it is given back. Poll \`GET /v1/tools/runs/{runId}\`.`, {
      tags: ["Tools"],
      parameters: [IDEMPOTENCY_HEADER],
      // the tool's input, with an optional webhook beside it
      requestBody: { required: true, content: json({ allOf: [ref(input), { type: "object", properties: { webhook: ref("WebhookRequest") } }] }) },
      responses: { "202": { description: "Started.", content: json(ref("ToolRunAccepted")) }, ...errors("400", "401", "402", "409", "429", "503") },
    });

  return {
    openapi: "3.1.0",
    info: {
      title: "Magica Clone API",
      version: "1",
      description:
        "Send messages to the agent, read conversations, follow runs, answer approvals, and run Magica tools directly. Every response carries `x-api-version: 1` and `x-trace-id`; every error is `{ error, code, details?, traceId }`. Work that takes time starts at once and returns a run to poll.",
    },
    servers,
    security: [{ ApiKey: [] }, { Bearer: [] }],
    tags: [
      { name: "Messages", description: "Talk to the agent." },
      { name: "Runs", description: "Follow, stop and answer runs." },
      { name: "Tools", description: "Run Magica tools directly." },
      { name: "Account", description: "Credits and media." },
      { name: "Webhooks", description: "What we send to your webhook URL." },
    ],
    paths: {
      "/v1/messages": {
        post: operation("Send a message", "Sends a message to the agent, in a new chat or (with `chatId`) an existing one, and returns at once with the run to poll.", {
          tags: ["Messages"],
          parameters: [IDEMPOTENCY_HEADER],
          requestBody: { required: true, content: json(ref("SendMessageRequest")) },
          responses: { "202": { description: "Accepted: the agent is working on it.", content: json(ref("MessageAccepted")) }, ...errors("400", "401", "402", "404", "409", "413", "429", "503") },
        }),
      },
      "/v1/chat/completions": {
        post: operation(
          "Create a chat completion",
          "The chat-completions format, answered by the agent through the free model router (`model` must be `openrouter/free`). Not streamed. The conversation is kept as a chat. Waits about a minute for the answer; if it takes longer, answers 202 with the run to poll.",
          {
            tags: ["Messages"],
            parameters: [IDEMPOTENCY_HEADER],
            requestBody: { required: true, content: json(ref("ChatCompletionRequest")) },
            responses: {
              "200": { description: "The answer.", content: json(ref("ChatCompletion")) },
              "202": { description: "Still working: poll `GET /v1/runs/{run_id}`.", content: json(ref("ChatCompletionPending")) },
              ...errors("400", "401", "402", "409", "413", "429", "503"),
            },
          },
        ),
      },
      "/v1/chats": {
        get: operation("List chats", "Your chats, pinned first, then most recent. Pass `cursor` from one page to get the next.", {
          tags: ["Messages"],
          parameters: query(ChatListQuerySchema),
          responses: { "200": { description: "A page of chats.", content: json(ref("ChatList")) }, ...errors("400", "401", "429") },
        }),
      },
      "/v1/chats/{chatId}/messages": {
        get: operation("List a chat's messages", "Finished messages, oldest to newest within a page; `cursor` fetches older ones. A reply being written is read from its run.", {
          tags: ["Messages"],
          parameters: [pathId("chatId", "The chat."), ...query(MessageListQuerySchema)],
          responses: { "200": { description: "A page of messages.", content: json(ref("MessageList")) }, ...errors("400", "401", "404", "429") },
        }),
      },
      "/v1/runs/{runId}": {
        get: operation("Get a run", "Where the run stands, its usage, its reply so far, the tool calls it made (with what they made), and what it waits for.", {
          tags: ["Runs"],
          parameters: [pathId("runId", "The run.")],
          responses: { "200": { description: "The run.", content: json(ref("RunResponse")) }, ...errors("401", "404", "429") },
        }),
      },
      "/v1/runs/{runId}/cancel": {
        post: operation("Stop a run", "Stops the run if it is still going (what it wrote so far is kept), and returns it as it stands.", {
          tags: ["Runs"],
          parameters: [pathId("runId", "The run.")],
          responses: { "200": { description: "The run.", content: json(ref("RunResponse")) }, ...errors("401", "404", "429") },
        }),
      },
      "/v1/waitpoints/{waitpointId}/respond": {
        post: operation("Answer a waitpoint", "Approves a plan or a spend, asks for changes, or rejects. Answering one that is already closed returns it as it stands.", {
          tags: ["Runs"],
          parameters: [pathId("waitpointId", "The waitpoint (`pendingWaitpoint.id` of the run).")],
          requestBody: { required: true, content: json(ref("RespondWaitpointRequest")) },
          responses: { "200": { description: "The waitpoint.", content: json(ref("RespondWaitpointResponse")) }, ...errors("400", "401", "404", "429", "503") },
        }),
      },
      "/v1/tools/gpt-image-2": { post: tool("GPT Image 2", "GptImage2Input", "Creates an image from a prompt, or edits images.") },
      "/v1/tools/crop-image": { post: tool("Crop Image", "CropImageInput", "Keeps a rectangle of an image.") },
      "/v1/tools/merge-videos": { post: tool("Merge Videos", "MergeVideosInput", "Joins videos into one.") },
      "/v1/tools/runs/{runId}": {
        get: operation("Get a tool run", "A tool run's status, input, credits, duration, what it made, and its error if it failed.", {
          tags: ["Tools"],
          parameters: [pathId("runId", "The tool run.")],
          responses: { "200": { description: "The tool run.", content: json(ref("ToolRunResponse")) }, ...errors("401", "404", "429") },
        }),
      },
      "/v1/credits": {
        get: operation("Get credits", "Your balance, and how much of it is held by work in progress.", {
          tags: ["Account"],
          responses: { "200": { description: "Your credits.", content: json(ref("Credits")) }, ...errors("401", "429") },
        }),
      },
      "/v1/media": {
        get: operation("List media", "Your media library: uploads (until they expire) and generated media, newest first.", {
          tags: ["Account"],
          parameters: query(MediaListQuerySchema),
          responses: { "200": { description: "A page of media.", content: json(ref("MediaList")) }, ...errors("400", "401", "429") },
        }),
      },
    },
    webhooks: Object.fromEntries(WEBHOOK_EVENTS.map((event) => [event, webhookOperation(event)])),
    components: {
      securitySchemes: {
        ApiKey: { type: "apiKey", in: "header", name: "x-api-key", description: "An API key (`mgc_…`) from API / MCP in the app." },
        Bearer: { type: "http", scheme: "bearer", description: "An API key (`Bearer mgc_…`), or a signed-in session token." },
      },
      schemas: { ...Object.fromEntries(Object.entries(COMPONENTS).map(([name, [schema, io]]) => [name, jsonSchema(schema, io)])), ChatCompletionRequest: completionRequest() },
    },
  };
}
