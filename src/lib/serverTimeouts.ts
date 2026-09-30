import type { Server } from "node:http";

/** Sheds slow or idle clients. Request bodies here are at most 1 MB, so 30 s to send one is generous. */
export function applyServerTimeouts(server: Server): void {
  // stay above typical load-balancer idle timeouts (often 60 s), or a reused connection is dropped mid-request
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;
}
