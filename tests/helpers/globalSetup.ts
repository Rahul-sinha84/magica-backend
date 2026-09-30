import { execFileSync } from "node:child_process";
import { TEST_DATABASE_URL, assertTestDatabase } from "./guard.js";

// Runs once before the integration suite: applies every committed migration to the test database.
export default function setup(): void {
  assertTestDatabase(TEST_DATABASE_URL);
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, DIRECT_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });
}
