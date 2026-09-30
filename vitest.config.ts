import { defineConfig } from "vitest/config";
import { TEST_DATABASE_URL } from "./tests/helpers/guard.js";

// `source` makes `#src/*` resolve to TypeScript sources instead of dist/.
const resolve = { conditions: ["source"] };

export default defineConfig({
  resolve,
  ssr: { resolve },
  test: {
    passWithNoTests: true,
    // replaces src/auth/clerk.ts (the only Clerk import) in every test
    setupFiles: ["tests/helpers/setupClerkMock.ts"],
    // Applied before any test module loads, so env/db modules only ever see the test database.
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "fatal",
      DATABASE_URL: TEST_DATABASE_URL,
      CLERK_SECRET_KEY: "sk_test_placeholder",
      CLERK_PUBLISHABLE_KEY: "pk_test_placeholder",
      TRIGGER_SECRET_KEY: "tr_dev_placeholder",
      FRONTEND_ORIGIN: "http://localhost:3001",
      OPENROUTER_API_KEY: "sk-or-placeholder",
    },
    projects: [
      { extends: true, test: { name: "unit", include: ["tests/unit/**/*.test.ts"] } },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/helpers/globalSetup.ts"],
          // One shared database: files run one at a time so truncation never races another file.
          fileParallelism: false,
        },
      },
    ],
  },
});
