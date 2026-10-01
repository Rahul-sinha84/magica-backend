import { additionalFiles } from "@trigger.dev/build/extensions/core";
import { defineConfig } from "@trigger.dev/sdk";

// The CLI evaluates this file before anything loads .env.local for it. The file is optional (real hosts set variables).
try {
  process.loadEnvFile(".env.local");
} catch {
  /* no .env.local */
}

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "",
  dirs: ["./src/trigger"],
  maxDuration: 600,
  // a turn is never retried: a retry would call the model a second time for a reply the user may already be reading
  retries: { enabledInDev: false, default: { maxAttempts: 1 } },
  build: {
    // lets the bundler resolve our own `#src/*` imports to the TypeScript sources (see package.json "imports")
    conditions: ["magica-source"],
    // kept out of the bundle: the database driver and its generated client load native/wasm files, and pino uses threads
    external: ["@prisma/client", "@prisma/adapter-pg", "pg", "pino", "pino-pretty"],
    // the worker reads the agent's skills from disk at startup, so a deploy must ship them next to the code
    extensions: [additionalFiles({ files: ["./agent-skills/**"] })],
  },
});
