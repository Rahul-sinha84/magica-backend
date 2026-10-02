import { randomUUID } from "node:crypto";
import express, { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from "express";
import { ipKeyGenerator } from "express-rate-limit";
import { clerkUserId } from "#src/auth/clerk.js";
import { currentUserId } from "#src/auth/middleware.js";
import { ensureUser } from "#src/auth/users.js";
import {
  API_KEY_PREFIX,
  API_VERSION,
  ChatListQuerySchema,
  ChatListResponseSchema,
  CreditsResponseSchema,
  MediaListQuerySchema,
  MediaListResponseSchema,
  MessageListQuerySchema,
  MessageListResponseSchema,
  RespondWaitpointBodySchema,
  RespondWaitpointResponseSchema,
  V1MessageAcceptedSchema,
  V1RunResponseSchema,
  V1SendMessageBodySchema,
} from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { AppError, toErrorResponse } from "#src/lib/errors.js";
import { IdSchema } from "#src/lib/cursor.js";
import { addLogContext, logContext, logger } from "#src/lib/logger.js";
import { completeWaitpointToken } from "#src/lib/trigger.js";
import { WindowCounters } from "#src/lib/windowCounter.js";
import { findWorkingApiKey } from "#src/services/apiKeys.js";
import { createChat, deleteChat, listChats, parseChatId, requireChat } from "#src/services/chats.js";
import { getCredits } from "#src/services/credits.js";
import { parseIdempotencyKey, withIdempotency } from "#src/services/idempotency.js";
import { listMedia } from "#src/services/media.js";
import { listMessages } from "#src/services/messages.js";
import { sendMessage } from "#src/services/turns.js";
import { cancelV1Run, getV1Run } from "#src/services/v1Runs.js";
import { respondToWaitpoint } from "#src/services/waitpoints.js";

// The public API, /v1. It reuses the app's own services (the same rules, the same records); only the way in differs:
// an API key or a session token, per-key limits, and errors that carry the trace id.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// a session token (no API key) gets the same allowance as the app's own API
const SESSION_PER_MINUTE = 300;
// failed sign-ins from one address, per minute, before it is told to slow down
const FAILED_AUTH_PER_MINUTE = 30;
// how often lastUsedAt is written for a busy key
const LAST_USED_EVERY_MS = MINUTE;

const BEARER = /^Bearer\s+(\S+)$/i;

/** The API key a request presents (x-api-key, or a Bearer that looks like one), or undefined when it presents none. */
function presentedKey(req: Request): string | undefined {
  const header = req.get("x-api-key");
  if (header !== undefined) return header.trim();
  const bearer = BEARER.exec(req.get("authorization") ?? "")?.[1];
  return bearer?.startsWith(API_KEY_PREFIX) ? bearer : undefined;
}

const traceIdOf = () => logContext.getStore()?.traceId ?? randomUUID();

export interface V1Options {
  /** verifies a session token (the app's Clerk middleware) */
  sessionAuth: RequestHandler;
  /** the app's limiter for starting turns, shared so the public API can't double anyone's allowance */
  sendLimit: RequestHandler;
}

export function v1Router({ sessionAuth, sendLimit }: V1Options): Router {
  const router = Router();
  const counters = new WindowCounters();

  const tooMany = (res: Response, message: string, retryAfterMs: number, details: Record<string, unknown>) => {
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    res.setHeader("Retry-After", String(seconds));
    return new AppError("RATE_LIMITED", message, { ...details, retryAfterSeconds: seconds });
  };

  // a sign-in that didn't work: 401, or 429 once an address keeps trying
  const refuse = (req: Request, res: Response, message: string): never => {
    const counted = counters.take(`failed:${ipKeyGenerator(req.ip ?? "")}`, [{ name: "minute", windowMs: MINUTE, limit: FAILED_AUTH_PER_MINUTE }]);
    if (!counted.ok) throw tooMany(res, "Too many failed sign-ins. Wait a moment and try again.", counted.retryAfterMs, {});
    res.setHeader("WWW-Authenticate", "Bearer");
    throw new AppError("UNAUTHORIZED", message);
  };

  router.use((_req, res, next) => {
    res.setHeader("x-api-version", API_VERSION);
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // Who is calling: an API key, or else a session token. Every refusal looks the same, whatever the reason.
  router.use(async (req, res, next) => {
    const secret = presentedKey(req);
    if (secret !== undefined) {
      const key = await findWorkingApiKey(secret);
      if (!key) refuse(req, res, "That API key isn't valid. Check it, or create a new one.");
      else {
        const counted = counters.take(`key:${key.id}`, [
          { name: "minute", windowMs: MINUTE, limit: key.perMinute },
          { name: "day", windowMs: DAY, limit: key.perDay },
        ]);
        if (!counted.ok) {
          const which = counted.window === "minute" ? "per-minute" : "daily";
          throw tooMany(res, `This API key's ${which} limit of ${counted.limit} requests is used up.`, counted.retryAfterMs, { window: counted.window, limit: counted.limit });
        }
        res.locals.userId = key.userId;
        addLogContext({ userId: key.userId, apiKeyId: key.id });
        if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() >= LAST_USED_EVERY_MS) {
          await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch((err: unknown) => logger.warn({ err }, "could not record the key's last use"));
        }
      }
      next();
      return;
    }
    sessionAuth(req, res, (error?: unknown) => {
      if (error) return next(error);
      void (async () => {
        const userId = clerkUserId(req);
        if (!userId) refuse(req, res, "Use an API key (x-api-key or Authorization: Bearer mgc_…) or a session token.");
        else {
          const counted = counters.take(`user:${userId}`, [{ name: "minute", windowMs: MINUTE, limit: SESSION_PER_MINUTE }]);
          if (!counted.ok) throw tooMany(res, "Too many requests. Wait a moment and try again.", counted.retryAfterMs, { window: "minute", limit: SESSION_PER_MINUTE });
          await ensureUser(userId);
          res.locals.userId = userId;
          addLogContext({ userId });
        }
      })().then(() => next(), next);
    });
  });

  router.use(express.json({ limit: "1mb" })); // only once the caller is known

  // Sends a message (in a new chat unless chatId is given) and returns at once; poll the run.
  router.post("/messages", sendLimit, async (req, res) => {
    const body = V1SendMessageBodySchema.parse(req.body);
    const key = parseIdempotencyKey(req.get("idempotency-key"));
    const userId = currentUserId(res);
    const result = await withIdempotency({ userId, scope: "POST /v1/messages", key, body }, async () => {
      if (body.chatId) await requireChat(userId, body.chatId);
      const chatId = body.chatId ?? (await createChat(userId)).id;
      addLogContext({ chatId });
      try {
        const turn = await sendMessage({ userId, chatId, body: { content: body.content, attachments: body.attachments, mode: body.mode }, traceId: traceIdOf() });
        addLogContext({ runId: turn.runId, messageId: turn.message.id });
        logger.info("message accepted through the public API");
        return { status: 202, body: V1MessageAcceptedSchema.parse({ chatId, messageId: turn.message.id, runId: turn.runId, status: "queued" }) };
      } catch (error) {
        if (!body.chatId) await deleteChat(userId, chatId).catch((err: unknown) => logger.warn({ err }, "could not remove the chat of a send that failed"));
        throw error;
      }
    });
    res.setHeader("idempotent-replayed", String(result.replayed));
    res.status(result.status).json(result.body);
  });

  router.get("/chats", async (req, res) => {
    res.json(ChatListResponseSchema.parse(await listChats(currentUserId(res), ChatListQuerySchema.parse(req.query))));
  });

  router.get("/chats/:chatId/messages", async (req, res) => {
    const query = MessageListQuerySchema.parse(req.query);
    res.json(MessageListResponseSchema.parse(await listMessages(currentUserId(res), parseChatId(req.params.chatId), query)));
  });

  const runId = (raw: string) => {
    const id = IdSchema.safeParse(raw);
    if (!id.success) throw new AppError("NOT_FOUND", "That run isn't there.");
    addLogContext({ runId: id.data });
    return id.data;
  };

  router.get("/runs/:runId", async (req, res) => {
    res.json(V1RunResponseSchema.parse({ run: await getV1Run(currentUserId(res), runId(req.params.runId)) }));
  });

  router.post("/runs/:runId/cancel", async (req, res) => {
    res.json(V1RunResponseSchema.parse({ run: await cancelV1Run(currentUserId(res), runId(req.params.runId)) }));
  });

  router.post("/waitpoints/:waitpointId/respond", async (req, res) => {
    const id = IdSchema.safeParse(req.params.waitpointId);
    if (!id.success) throw new AppError("NOT_FOUND", "That approval isn't there any more.");
    addLogContext({ waitpointId: id.data });
    const body = RespondWaitpointBodySchema.parse(req.body);
    const waitpoint = await respondToWaitpoint(currentUserId(res), id.data, body, { completeToken: completeWaitpointToken });
    res.json(RespondWaitpointResponseSchema.parse({ waitpoint }));
  });

  router.get("/credits", async (_req, res) => {
    const credits = await getCredits(currentUserId(res));
    if (!credits) throw new AppError("INTERNAL_ERROR", "Your account couldn't be loaded. Please try again.");
    res.json(CreditsResponseSchema.parse(credits));
  });

  router.get("/media", async (req, res) => {
    res.json(MediaListResponseSchema.parse(await listMedia(currentUserId(res), MediaListQuerySchema.parse(req.query))));
  });

  router.use(() => {
    throw new AppError("NOT_FOUND", "That endpoint doesn't exist. See the API reference for /v1.");
  });

  // Errors carry the trace id (as the x-trace-id header does), so a caller can quote it.
  const errors: ErrorRequestHandler = (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const { status, body, unexpected } = toErrorResponse(error);
    const fields = { status, code: body.code, method: req.method, path: req.originalUrl.split("?")[0] };
    if (unexpected) logger.error({ ...fields, err: error }, "request failed");
    else logger.info(fields, "request rejected");
    res.status(status).json({ ...body, traceId: traceIdOf() });
  };
  router.use(errors);

  return router;
}
