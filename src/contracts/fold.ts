import type { ContentBlock } from "./messages.js";
import type { AgentStreamChunk } from "./runs.js";

function appendDelta(blocks: ContentBlock[], type: "text" | "thinking", delta: string): void {
  if (!delta) return;
  const last = blocks[blocks.length - 1];
  if (last && last.type === type) last.content += delta;
  else blocks.push({ type, content: delta });
}

/**
 * Turns the stream into content blocks. Pure: the same array always gives the same blocks, so the server
 * (persisting partial output) and the client (rendering) can never disagree, and re-folding after a
 * reconnect never duplicates anything.
 *
 * The returned blocks may share nested objects (`toolInput`, `result`) with the chunks, so treat both as
 * read-only.
 *
 * A tool_result is placed right after its tool_call, so a call and its outcome stay adjacent even when
 * text or other tools streamed in between. Chunks that don't fit (an end without a start, a repeated
 * start or end) are ignored instead of corrupting the message.
 */
export function foldChunks(chunks: readonly AgentStreamChunk[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const chunk of chunks) {
    switch (chunk.type) {
      case "text-delta":
        appendDelta(blocks, "text", chunk.delta);
        break;
      case "thinking-delta":
        appendDelta(blocks, "thinking", chunk.delta);
        break;
      case "tool-start": {
        const known = blocks.some((b) => b.type === "tool_call" && b.toolCallId === chunk.toolCallId);
        if (!known) {
          blocks.push({
            type: "tool_call",
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            toolInput: chunk.toolInput,
            status: "running",
          });
        }
        break;
      }
      case "tool-end": {
        const index = blocks.findIndex((b) => b.type === "tool_call" && b.toolCallId === chunk.toolCallId);
        const call = blocks[index];
        const done = blocks.some((b) => b.type === "tool_result" && b.toolCallId === chunk.toolCallId);
        if (call?.type !== "tool_call" || done) break;

        call.status = chunk.status;
        if (chunk.durationMs !== undefined) call.durationMs = chunk.durationMs;
        if (chunk.creditCost !== undefined) call.creditCost = chunk.creditCost;
        blocks.splice(index + 1, 0, {
          type: "tool_result",
          toolCallId: chunk.toolCallId,
          toolName: call.toolName,
          ...(chunk.result !== undefined && { result: chunk.result }),
          isError: chunk.status === "failed",
          ...(chunk.errorMessage !== undefined && { errorMessage: chunk.errorMessage }),
        });
        break;
      }
      case "asset":
        blocks.push({ ...chunk.asset });
        break;
      case "waitpoint-start": {
        const known = blocks.some((b) => b.type === "waitpoint" && b.waitpointId === chunk.waitpointId);
        if (known) break;
        blocks.push({ ...chunk, type: "waitpoint", status: "pending" });
        break;
      }
      case "waitpoint-end": {
        const card = blocks.find((b) => b.type === "waitpoint" && b.waitpointId === chunk.waitpointId);
        if (card?.type !== "waitpoint" || card.status !== "pending") break;
        card.status = chunk.status;
        card.waitedMs = chunk.waitedMs;
        if (chunk.feedback !== undefined) card.feedback = chunk.feedback;
        break;
      }
    }
  }

  return blocks;
}

/** The plain text of a message: every text block, in order. Thinking and tool blocks are not part of it. */
export function blocksToText(blocks: readonly ContentBlock[]): string {
  return blocks.map((b) => (b.type === "text" ? b.content : "")).join("");
}
