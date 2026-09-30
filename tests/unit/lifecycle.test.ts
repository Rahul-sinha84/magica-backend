import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "#src/lib/logger.js";
import { createShutdown } from "#src/lib/lifecycle.js";

const log = createLogger("silent");
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.closeAllConnections();
});

async function start(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

const get = (port: number, path = "/") =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });

const exited = (exit: ReturnType<typeof vi.fn>) => vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 3_000 });

describe("createShutdown", () => {
  it("lets a request that is already running finish, then cleans up and exits 0", async () => {
    const { server, port } = await start((_req, res) => void setTimeout(() => res.end("done"), 200));
    const exit = vi.fn();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const shutdown = createShutdown(server, { exit, cleanup, log });

    const inFlight = get(port);
    await new Promise((resolve) => setTimeout(resolve, 50));
    shutdown("SIGTERM");

    expect(await inFlight).toEqual({ status: 200, body: "done" });
    await exited(exit);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("stops accepting new connections once it has started", async () => {
    const { server, port } = await start((_req, res) => void setTimeout(() => res.end("done"), 300));
    const exit = vi.fn();
    const shutdown = createShutdown(server, { exit, log });

    const inFlight = get(port);
    await new Promise((resolve) => setTimeout(resolve, 50));
    shutdown("SIGTERM");
    // a refused localhost connection is an AggregateError (IPv4 and IPv6 attempts): the code is on the error, not its message
    const refused = await get(port).then(
      () => undefined,
      (error: NodeJS.ErrnoException & { errors?: NodeJS.ErrnoException[] }) => error,
    );
    expect(refused?.code ?? refused?.errors?.[0]?.code).toBe("ECONNREFUSED");
    await inFlight;
    await exited(exit);
  });

  it("exits promptly when nothing is running", async () => {
    const { server } = await start((_req, res) => void res.end("ok"));
    const exit = vi.fn();
    const started = Date.now();
    createShutdown(server, { exit, log })("SIGINT");
    await exited(exit);
    expect(exit).toHaveBeenCalledWith(0);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("does not wait for an idle keep-alive connection", async () => {
    const { server, port } = await start((_req, res) => void res.end("ok"));
    // a client that finished its request but keeps the connection open for reuse
    await new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port, headers: { Connection: "keep-alive" } }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.end();
    });
    const exit = vi.fn();
    createShutdown(server, { exit, log })("SIGTERM");
    await exited(exit);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("forces exit 1 when a request never finishes within the grace period", async () => {
    const { server, port } = await start(() => undefined); // never answers
    const exit = vi.fn();
    const shutdown = createShutdown(server, { exit, graceMs: 150, log });
    void get(port).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    shutdown("SIGTERM");
    await exited(exit);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does the work once however many times it is called, and a second signal stops at once", async () => {
    const { server, port } = await start(() => undefined);
    const exit = vi.fn();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const shutdown = createShutdown(server, { exit, cleanup, graceMs: 5_000, log });
    void get(port).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));

    shutdown("SIGINT");
    expect(exit).not.toHaveBeenCalled();
    shutdown("SIGINT"); // impatient Ctrl-C
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("still exits when cleanup fails", async () => {
    const { server } = await start((_req, res) => void res.end("ok"));
    const exit = vi.fn();
    createShutdown(server, { exit, cleanup: () => Promise.reject(new Error("db already gone")), log })("SIGTERM");
    await exited(exit);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits 1 when the server was not running", async () => {
    const server = createServer();
    const exit = vi.fn();
    createShutdown(server, { exit, log })("SIGTERM");
    await exited(exit);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
