import { defineConfig } from "prisma/config";

// Prisma 7 no longer loads .env files itself. The file is optional (CI and hosts set real env vars).
try {
  process.loadEnvFile(".env.local");
} catch {
  /* no .env.local */
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Migrations should bypass a pooler (e.g. Neon's) via DIRECT_URL; the app itself uses DATABASE_URL.
  datasource: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL },
});
