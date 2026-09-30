import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

// A stand-in for OpenRouter's streaming chat endpoint that can be made to misbehave in every way the real one can.
export type Step = (req: IncomingMessage, res: ServerResponse, index: number) => void | Promise<void>;

export interface RecordedRequest {
  body: Record<string, unknown>;
  headers: IncomingMessage["headers"];
}

export interface ModelServer {
  url: string;
  requests: RecordedRequest[];
  /** Connections that were closed by the client before the server finished. */
  closedEarly: () => number;
  close: () => Promise<void>;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
  });

/** One step per request, in order; the last step repeats if there are more requests than steps. */
export async function startModelServer(steps: Step[]): Promise<ModelServer> {
  const requests: RecordedRequest[] = [];
  let early = 0;
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    void readBody(req).then(async (raw) => {
      const index = requests.length;
      requests.push({ body: JSON.parse(raw || "{}") as Record<string, unknown>, headers: req.headers });
      res.on("close", () => {
        if (!res.writableFinished) early++;
      });
      await steps[Math.min(index, steps.length - 1)]?.(req, res, index);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    requests,
    closedEarly: () => early,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

// ---- building blocks for the responses ----

export interface ChunkSpec {
  content?: string | null;
  reasoning?: string | null;
  reasoningContent?: string | null;
  finish?: string | null;
  model?: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
  error?: { code?: number | string; message?: string };
  role?: boolean;
}

export const chunk = (spec: ChunkSpec) => ({
  id: "gen-test",
  object: "chat.completion.chunk",
  created: 1,
  model: spec.model ?? "provider/free-model",
  choices: spec.usage && !spec.content && !spec.reasoning ? [] : [
    {
      index: 0,
      delta: { ...(spec.role && { role: "assistant" }), ...(spec.content !== undefined && { content: spec.content }), ...(spec.reasoning !== undefined && { reasoning: spec.reasoning }), ...(spec.reasoningContent !== undefined && { reasoning_content: spec.reasoningContent }) },
      finish_reason: spec.finish ?? null,
    },
  ],
  ...(spec.usage && { usage: spec.usage }),
  ...(spec.error && { error: spec.error }),
});

export function startSse(res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
}

export const writeEvent = (res: ServerResponse, payload: object | string) => res.write(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);
export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A complete, healthy answer made of the given text pieces. */
export const answer = (pieces: string[], extra: { reasoning?: string[]; model?: string; tokens?: [number, number]; finish?: string } = {}): Step => (_req, res) => {
  startSse(res);
  writeEvent(res, chunk({ role: true, content: "", model: extra.model }));
  for (const piece of extra.reasoning ?? []) writeEvent(res, chunk({ reasoning: piece, model: extra.model }));
  for (const piece of pieces) writeEvent(res, chunk({ content: piece, model: extra.model }));
  writeEvent(res, chunk({ content: "", finish: extra.finish ?? "stop", model: extra.model }));
  writeEvent(res, chunk({ usage: { prompt_tokens: extra.tokens?.[0] ?? 11, completion_tokens: extra.tokens?.[1] ?? 22 }, model: extra.model }));
  writeEvent(res, "[DONE]");
  res.end();
};

export const status = (code: number, headers: Record<string, string> = {}, body: object = { error: { message: `status ${code}` } }): Step => (_req, res) => {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

export const emptyStream: Step = (_req, res) => {
  startSse(res);
  writeEvent(res, "[DONE]");
  res.end();
};

export const neverAnswers: Step = () => undefined;
