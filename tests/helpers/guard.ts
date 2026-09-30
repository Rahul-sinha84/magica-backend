// No Prisma import here: this file is used by vitest.config.ts and globalSetup, which run in the main
// process where DATABASE_URL may still point at the dev database.
// Imports are hoisted, so this must live here (not in vitest.config.ts) to run before TEST_DATABASE_URL is read.
try {
  process.loadEnvFile(".env.local");
} catch {
  /* no .env.local: fall back to the docker default below */
}

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://magica:magica@localhost:5432/magica_test";

/** Refuses anything that is not a dedicated test database, so a truncate can never hit dev data. */
export function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to touch database "${name}": integration tests only run against a *_test database.`);
  }
}
