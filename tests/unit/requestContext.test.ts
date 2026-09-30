import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it } from "vitest";
import { api } from "../helpers/http.js";
import { createLogger, logContext, addLogContext } from "#src/lib/logger.js";
import { requestContext } from "#src/middleware/requestContext.js";

function capture(level = "info") {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger(level, { write: (chunk: string) => void lines.push(JSON.parse(chunk) as Record<string, unknown>) });
  return { log, lines };
}

function makeApp(log = capture().log) {
  const app = express();
  app.use(requestContext(log));
  app.get("/ping", (_req, res) => void res.json({ ok: true }));
  return app;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("trace id", () => {
  it("generates one per request and echoes it in the response header", async () => {
    const app = makeApp();
    const [a, b] = await Promise.all([api(app).get("/ping"), api(app).get("/ping")]);
    expect(a.headers["x-trace-id"]).toMatch(UUID);
    expect(b.headers["x-trace-id"]).toMatch(UUID);
    expect(a.headers["x-trace-id"]).not.toBe(b.headers["x-trace-id"]);
  });

  it.each(["abcd1234", "trace_ID-0123456789", "a".repeat(64)])("keeps a well-formed incoming id %j", async (id) => {
    expect((await api(makeApp()).get("/ping").set("x-trace-id", id)).headers["x-trace-id"]).toBe(id);
  });

  it.each([
    ["too short", "abc"],
    ["too long", "a".repeat(65)],
    ["spaces", "has spaces in it"],
    ["quotes", 'quo"te-and-more'],
    ["markup", "<script>alert(1)</script>"],
    ["log injection", 'abcd1234","level":"fatal'],
    ["non-ascii", "tracé-identifiant"],
    ["empty", ""],
  ])("replaces an unsafe incoming id (%s)", async (_label, id) => {
    const res = await api(makeApp()).get("/ping").set("x-trace-id", id);
    expect(res.headers["x-trace-id"]).toMatch(UUID);
  });
});

describe("request log", () => {
  it("writes one line per request with trace id, method, path, status and duration", async () => {
    const { log, lines } = capture();
    const res = await api(makeApp(log)).get("/ping");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ msg: "request", method: "GET", path: "/ping", status: 200, traceId: res.headers["x-trace-id"] });
    expect(typeof lines[0]?.durationMs).toBe("number");
  });

  it("never logs the query string (it can carry tokens or cursors)", async () => {
    const { log, lines } = capture();
    await api(makeApp(log)).get("/ping?token=super-secret&cursor=abc");
    expect(JSON.stringify(lines)).not.toContain("super-secret");
    expect(lines[0]).toMatchObject({ path: "/ping" });
  });

  it("logs health checks at debug level only, so monitors do not flood the log", async () => {
    const { log, lines } = capture("info");
    const app = express();
    app.use(requestContext(log));
    app.get("/api/health", (_req, res) => void res.json({ ok: true }));
    await api(app).get("/api/health");
    expect(lines).toHaveLength(0);

    const debug = capture("debug");
    const app2 = express();
    app2.use(requestContext(debug.log));
    app2.get("/api/health", (_req, res) => void res.json({ ok: true }));
    await api(app2).get("/api/health");
    expect(debug.lines).toHaveLength(1);
  });

  it("escapes a hostile trace id instead of letting it forge log fields", async () => {
    const { log, lines } = capture();
    await api(makeApp(log)).get("/ping").set("x-trace-id", 'abcd1234","level":"fatal');
    expect(lines.every((line) => line.level === 30)).toBe(true); // 30 = info; a forged "fatal" would be 60
  });

  it("warns instead of reporting success when the client disconnects mid-request", async () => {
    const { log, lines } = capture();
    const app = express();
    app.use(requestContext(log));
    app.get("/slow", (_req, res) => void setTimeout(() => res.json({ late: true }), 300));
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening"); // with an explicit host the address is only known once it is listening
    const { port } = server.address() as AddressInfo;

    await new Promise<void>((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/slow" }, () => undefined);
      req.on("error", () => resolve());
      req.end();
      setTimeout(() => req.destroy(), 50);
    });
    await new Promise((resolve) => setTimeout(resolve, 450));
    await new Promise((resolve) => server.close(resolve));

    const aborted = lines.find((line) => line.msg === "request aborted by the client");
    expect(aborted).toMatchObject({ level: 40, method: "GET", path: "/slow" });
    expect(aborted).not.toHaveProperty("status"); // nothing was sent, so no status to report
    expect(lines.some((line) => line.msg === "request")).toBe(false);
  });
});

describe("log context", () => {
  it("attaches the trace id to lines written by handlers, across async boundaries", async () => {
    const { log, lines } = capture();
    const app = express();
    app.use(requestContext(log));
    app.get("/work", async (_req, res) => {
      log.info("before");
      await new Promise((resolve) => setTimeout(resolve, 20));
      addLogContext({ chatId: "chat_1" });
      log.info("after");
      res.json({ ok: true });
    });
    const res = await api(app).get("/work");
    const traceId = res.headers["x-trace-id"];
    expect(lines.find((l) => l.msg === "before")).toMatchObject({ traceId });
    expect(lines.find((l) => l.msg === "after")).toMatchObject({ traceId, chatId: "chat_1" });
    expect(lines.find((l) => l.msg === "request")).toMatchObject({ traceId, chatId: "chat_1" });
  });

  it("keeps concurrent requests' contexts apart", async () => {
    const { log, lines } = capture();
    const app = express();
    app.use(requestContext(log));
    app.get("/who/:name", async (req, res) => {
      addLogContext({ userId: req.params.name });
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 30));
      log.info({ marker: req.params.name }, "work");
      res.json({ ok: true });
    });
    await Promise.all(["a", "b", "c", "d", "e", "f"].map((name) => api(app).get(`/who/${name}`)));
    for (const line of lines.filter((l) => l.msg === "work")) expect(line.userId).toBe(line.marker);
  });

  it("does nothing outside a request", () => {
    expect(logContext.getStore()).toBeUndefined();
    expect(() => addLogContext({ chatId: "x" })).not.toThrow();
  });
});
