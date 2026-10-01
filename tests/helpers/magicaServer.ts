import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { createMagicaClient, type MagicaOptions } from "#src/lib/magica.js";

/** A real response captured from Magica (tests/fixtures/magica). */
export const fixture = <T = Record<string, unknown>>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/magica", name), "utf8")) as T;

/** One scripted answer. `close` drops the connection without answering; `delayMs` answers late. */
export interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  close?: boolean;
}

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

/**
 * A stand-in for the Magica API. Each route answers with its scripted replies in order (the last one repeats). Routes
 * are matched by "METHOD /path" with `*` matching one path segment.
 */
export async function startMagicaServer(routes: Record<string, Reply[]>) {
  const requests: Recorded[] = [];
  const counters = new Map<string, number>();
  const sockets = new Set<Socket>();

  const match = (method: string, path: string) =>
    Object.keys(routes).find((key) => {
      const [m, pattern = ""] = key.split(" ");
      return m === method && new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+")}$`).test(path);
    });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      requests.push({ method: req.method ?? "", path, headers: req.headers, body: raw ? (JSON.parse(raw) as unknown) : undefined });
      const key = match(req.method ?? "", path);
      if (!key) {
        res.writeHead(500).end("no scripted route");
        return;
      }
      const replies = routes[key] ?? [];
      const index = counters.get(key) ?? 0;
      counters.set(key, index + 1);
      const reply = replies[Math.min(index, replies.length - 1)] ?? { status: 500 };
      const send = () => {
        if (reply.close) {
          req.socket.destroy();
          return;
        }
        res.writeHead(reply.status ?? 200, { "Content-Type": reply.text !== undefined ? "text/html" : "application/json", ...reply.headers });
        res.end(reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json)));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs).unref();
      else send();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    requests,
    count: (method: string, path?: string) => requests.filter((r) => r.method === method && (!path || r.path === path)).length,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export const TEST_KEY = "gx_testkey_0123456789abcdef";

/**
 * A client for the fake server with a fake clock: `sleep` returns at once but moves the clock forward, so polling
 * schedules and five-minute timeouts run instantly. `sleeps` records every wait.
 */
export function fakeClockClient(baseUrl: string, overrides: Partial<MagicaOptions> = {}) {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const client = createMagicaClient({
    baseUrl,
    apiKey: TEST_KEY,
    now: () => clock,
    sleep: (ms, signal) => {
      if (signal?.aborted) return Promise.reject(signal.reason as Error);
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    ...overrides,
  });
  return { client, sleeps, advance: (ms: number) => (clock += ms), now: () => clock };
}
