import { defineConfig } from "vitest/config";

// Lets TEST_DATABASE_URL from .env.local reach the config below (Node >= 22 built-in; the file is optional).
try {
  process.loadEnvFile(".env.local");
} catch {
  /* no .env.local: fall back to the docker defaults */
}

// `source` makes `#src/*` resolve to TypeScript sources instead of dist/.
const resolve = { conditions: ["source"] };

export default defineConfig({
  resolve,
  ssr: { resolve },
  test: {
    passWithNoTests: true,
    // Applied before any test module loads, so env/db modules only ever see the test database.
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://magica:magica@localhost:5432/magica_test",
      CLERK_SECRET_KEY: "sk_test_placeholder",
      CLERK_PUBLISHABLE_KEY: "pk_test_placeholder",
      TRIGGER_SECRET_KEY: "tr_dev_placeholder",
      OPENROUTER_API_KEY: "sk-or-placeholder",
    },
    projects: [
      { extends: true, test: { name: "unit", include: ["tests/unit/**/*.test.ts"] } },
      { extends: true, test: { name: "integration", include: ["tests/integration/**/*.test.ts"] } },
    ],
  },
});
