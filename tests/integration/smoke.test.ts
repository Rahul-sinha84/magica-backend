import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "#src/app.js";
import { resetDb } from "../helpers/db.js";

const run = promisify(execFile);

// Runs scripts/smoke.sh against the real app (Clerk and Trigger.dev mocked), so the script is known to work and to
// match the API before anyone runs it by hand.
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(createApp({ rateLimits: { authenticated: 1_000_000, anonymous: 1_000_000 }, sendLimit: 1_000_000 }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(resetDb);

async function smoke(env: Record<string, string>) {
  try {
    const { stdout, stderr } = await run("bash", ["scripts/smoke.sh"], { env: { ...process.env, ...env }, timeout: 60_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

describe("scripts/smoke.sh", () => {
  it("passes every check against the API", async () => {
    const result = await smoke({ BASE_URL: base, TEST_TOKEN: "test:smoke_user" });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("all checks passed");
    expect(result.stdout).not.toContain("✘");
    expect(result.stdout.match(/✔/g)?.length).toBeGreaterThanOrEqual(20);
  }, 70_000);

  it("fails, and says which check, when the API answers wrongly", async () => {
    const result = await smoke({ BASE_URL: base, TEST_TOKEN: "not-a-valid-token" });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/✘ credits \(HTTP 401/);
  }, 70_000);

  it("refuses to start without a token", async () => {
    const result = await smoke({ BASE_URL: base, TEST_TOKEN: "" });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("set TEST_TOKEN");
  });
});
