import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// The agent task runs on Trigger.dev's workers, bundled on its own. It must never pull in the API's server-only code
// (Clerk keys, the Trigger client used to start runs, routes, Express), which the worker neither has nor needs.
describe("the agent task's bundle", () => {
  it.each(["src/trigger/agentTurn.ts", "src/trigger/magicaToolTask.ts"])("%s contains worker code and nothing that belongs to the API", async (entry) => {
    const result = await build({
      entryPoints: [entry],
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
    expect(inputs.some((file) => file.endsWith(entry.includes("magica") ? "src/tools/magicaInvocation.ts" : "src/agent/runTurn.ts"))).toBe(true);
    expect(inputs.some((file) => file.endsWith("src/env/worker.ts"))).toBe(true);

    const forbidden = ["src/env/server.ts", "src/lib/trigger.ts", "src/auth/", "src/routes/", "src/app.ts", "src/server.ts", "src/middleware/"];
    for (const part of forbidden) expect(inputs.filter((file) => file.includes(part)), part).toEqual([]);
    expect(inputs.filter((file) => /node_modules\/(express|@clerk)/.test(file))).toEqual([]);
  });
});

// The other direction: the API server runs without the worker's settings (OpenRouter and Magica keys), and reading the
// worker's environment at import time would stop it from starting. Shared pieces must live in env-free modules.
describe("the API server's bundle", () => {
  it("contains nothing that belongs to the worker", async () => {
    const result = await build({
      entryPoints: ["src/server.ts"],
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
      conditions: ["magica-source"],
      packages: "external",
    });
    const inputs = Object.keys(result.metafile.inputs);
    expect(inputs.some((file) => file.endsWith("src/env/server.ts"))).toBe(true);

    const forbidden = ["src/env/worker.ts", "src/lib/openrouter.ts", "src/lib/magica.ts", "src/agent/runTurn.ts", "src/trigger/", "src/skills/"];
    for (const part of forbidden) expect(inputs.filter((file) => file.includes(part)), part).toEqual([]);
    const packages = Object.values(result.metafile.outputs).flatMap((output) => output.imports.map((entry) => entry.path));
    expect(packages).not.toContain("openai");
  });
});
