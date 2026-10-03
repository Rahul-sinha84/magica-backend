import { Router } from "express";
import { currentUserId } from "#src/auth/middleware.js";
import {
  ChatListQuerySchema,
  ChatListResponseSchema,
  ChatResponseSchema,
  ChatSearchQuerySchema,
  ChatSearchResponseSchema,
  CreateChatBodySchema,
  UpdateChatBodySchema,
} from "#src/contracts/index.js";
import { createChat, deleteChat, listChats, parseChatId, requireChat, searchChats, updateChat } from "#src/services/chats.js";
import { serializeChat } from "#src/services/serialize.js";

export const chatsRouter = Router();

chatsRouter.get("/", async (req, res) => {
  const query = ChatListQuerySchema.parse(req.query);
  res.json(ChatListResponseSchema.parse(await listChats(currentUserId(res), query)));
});

// before "/:chatId", which would otherwise take "search" for a chat id
chatsRouter.get("/search", async (req, res) => {
  const query = ChatSearchQuerySchema.parse(req.query);
  res.json(ChatSearchResponseSchema.parse(await searchChats(currentUserId(res), query)));
});

chatsRouter.post("/", async (req, res) => {
  const { title } = CreateChatBodySchema.parse(req.body ?? {}); // no body at all means "use the defaults"
  const chat = await createChat(currentUserId(res), title);
  res.status(201).json(ChatResponseSchema.parse({ chat: serializeChat(chat) }));
});

chatsRouter.get("/:chatId", async (req, res) => {
  const chat = await requireChat(currentUserId(res), parseChatId(req.params.chatId));
  res.json(ChatResponseSchema.parse({ chat: serializeChat(chat) }));
});

chatsRouter.patch("/:chatId", async (req, res) => {
  const changes = UpdateChatBodySchema.parse(req.body);
  const chat = await updateChat(currentUserId(res), parseChatId(req.params.chatId), changes);
  res.json(ChatResponseSchema.parse({ chat: serializeChat(chat) }));
});

chatsRouter.delete("/:chatId", async (req, res) => {
  await deleteChat(currentUserId(res), parseChatId(req.params.chatId));
  res.status(204).end();
});
