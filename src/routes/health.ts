import { readFileSync } from "node:fs";
import { Router } from "express";
import { prisma } from "#src/db/client.js";
import { logger } from "#src/lib/logger.js";

// One level up from src/routes and from dist/routes alike, so this finds package.json either way.
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };

const DB_TIMEOUT_MS = 2_000;

async function databaseIsUp(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("database ping timed out")), DB_TIMEOUT_MS);
  });
  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    return true;
  } catch (err) {
    logger.error({ err }, "health check: database unreachable");
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// No auth and no rate limit: load balancers and uptime monitors call this.
export const healthRouter = Router().get("/", async (_req, res) => {
  const up = await databaseIsUp();
  res.status(up ? 200 : 503).json({ status: up ? "ok" : "degraded", db: up ? "up" : "down", version, timestamp: new Date().toISOString() });
});
