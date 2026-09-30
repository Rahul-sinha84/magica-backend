import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// The agent task runs on Trigger.dev's workers, bundled on its own. It must never pull in the API's server-only code
// (Clerk keys, the Trigger client used to start runs, routes, Express), which the worker neither has nor needs.
describe("the agent task's bundle", () => {
  it("contains the agent and nothing that belongs to the API", async () => {
    const result = await build({
      entryPoints: ["src/trigger/agentTurn.ts"],
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
      conditions: ["magica-source"],
      external: ["@prisma/client", "@prisma/adapter-pg", "pg", "pino", "pino-pretty", "@trigger.dev/sdk", "@trigger.dev/sdk/*", "openai", "zod"],
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.some((file) => file.endsWith("src/agent/runTurn.ts"))).toBe(true);
    expect(inputs.some((file) => file.endsWith("src/env/worker.ts"))).toBe(true);

    const forbidden = ["src/env/server.ts", "src/lib/trigger.ts", "src/auth/", "src/routes/", "src/app.ts", "src/server.ts", "src/middleware/"];
    for (const part of forbidden) expect(inputs.filter((file) => file.includes(part)), part).toEqual([]);
    expect(inputs.filter((file) => /node_modules\/(express|@clerk)/.test(file))).toEqual([]);
  });
});
