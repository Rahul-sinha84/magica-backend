import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";

// supertest starts its own throwaway server on a random port on ALL interfaces. On a developer machine other apps
// listen on 127.0.0.1 in that same port range (editors, Postman, ...), and now and then a test request reached one of
// them instead of ours, which showed up as random "socket hang up" failures and foreign responses. So there is one
// server per test file, bound to 127.0.0.1 explicitly (the operating system then picks a port that is free on that
// address) and started before any test runs. Each app gets its own URL prefix on it.
const apps = new Map<number, RequestListener>();
const ids = new WeakMap<RequestListener, number>();

const server = createServer((req, res) => {
  const match = /^\/__app\/(\d+)(\/.*)?$/.exec(req.url ?? "");
  const app = match?.[1] === undefined ? undefined : apps.get(Number(match[1]));
  if (!app) {
    res.statusCode = 500;
    res.end("no test app registered for this URL");
    return;
  }
  req.url = match?.[2] ?? "/"; // the app sees the path as if it were served on its own
  app(req, res);
});
server.listen(0, "127.0.0.1").unref();
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** `request(app)` for tests. */
export function api(app: RequestListener) {
  let id = ids.get(app);
  if (id === undefined) {
    id = apps.size;
    ids.set(app, id);
    apps.set(id, app);
  }
  return request(`${base}/__app/${id}`);
}

export const closeServers = (): Promise<void> => new Promise((resolve) => server.close(() => resolve()));
