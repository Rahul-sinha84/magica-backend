import { randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { currentUserId } from "#src/auth/middleware.js";
import { MessageListQuerySchema, MessageListResponseSchema, SendMessageBodySchema, SendMessageResponseSchema } from "#src/contracts/index.js";
import { addLogContext, logContext, logger } from "#src/lib/logger.js";
import { parseChatId } from "#src/services/chats.js";
import { listMessages } from "#src/services/messages.js";
import { realtimeAccess, sendMessage } from "#src/services/turns.js";

/** Mounted at /api/chats/:chatId/messages. Sending is the expensive operation, so it gets its own limiter. */
export function messagesRouter(sendLimit: RequestHandler): Router {
  const router = Router({ mergeParams: true });

  router.get<{ chatId: string }>("/", async (req, res) => {
    const query = MessageListQuerySchema.parse(req.query);
    res.json(MessageListResponseSchema.parse(await listMessages(currentUserId(res), parseChatId(req.params.chatId), query)));
  });

  router.post<{ chatId: string }>("/", sendLimit, async (req, res) => {
    const body = SendMessageBodySchema.parse(req.body);
    const chatId = parseChatId(req.params.chatId);
    addLogContext({ chatId });

    const turn = await sendMessage({ userId: currentUserId(res), chatId, body, traceId: logContext.getStore()?.traceId ?? randomUUID() });
    addLogContext({ runId: turn.runId, messageId: turn.message.id });
    logger.info({ replayed: turn.replayed, triggerRunId: turn.triggerRunId }, turn.replayed ? "message already accepted" : "message accepted");

    const { token, expiresAt } = await realtimeAccess(turn.triggerRunId);
    // 201 for a new turn, 200 when this is the answer to a message that was already accepted
    res.status(turn.replayed ? 200 : 201).json(
      SendMessageResponseSchema.parse({
        message: turn.message,
        chatId,
        runId: turn.runId,
        triggerRunId: turn.triggerRunId,
        realtimeToken: token,
        realtimeTokenExpiresAt: expiresAt.toISOString(),
      }),
    );
  });

  return router;
}
