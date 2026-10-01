import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "#src/env/base.js";
import { PrismaClient } from "#src/generated/prisma/client.js";

// A module-level singleton is enough under ESM: every importer shares one instance and one pool.
export const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    // Without these a stuck query or an exhausted pool hangs the request (and everything waiting on it) forever.
    connectionTimeoutMillis: 5_000,
    ...(env.DATABASE_STATEMENT_TIMEOUT_MS > 0 && { statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS }),
  }),
  log: env.LOG_LEVEL === "trace" ? ["query", "warn", "error"] : ["warn", "error"],
});

export { Prisma } from "#src/generated/prisma/client.js";
