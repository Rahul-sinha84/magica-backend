import { beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { prisma } from "#src/db/client.js";
import { PrismaClient } from "#src/generated/prisma/client.js";
import { toErrorResponse } from "#src/lib/errors.js";
import { fixtures, resetDb } from "../helpers/db.js";

beforeEach(resetDb);

// Real errors from the real database, run through the same mapper the error handler uses.
async function mapFailure(p: Promise<unknown>) {
  try {
    await p;
  } catch (error) {
    return toErrorResponse(error);
  }
  throw new Error("expected the operation to fail");
}

describe("real database errors", () => {
  it("a second active run in a chat becomes 409 RUN_ACTIVE", async () => {
    const user = await fixtures.user();
    const chat = await fixtures.chat(user.id);
    await fixtures.run(chat.id, user.id, "RUNNING");
    expect(await mapFailure(fixtures.run(chat.id, user.id, "PENDING"))).toMatchObject({ status: 409, body: { code: "RUN_ACTIVE" }, unexpected: false });
  });

  it("an over-hold reaching the CHECK becomes 402 INSUFFICIENT_CREDITS", async () => {
    const user = await fixtures.user({ balance: 100 });
    expect(await mapFailure(prisma.user.update({ where: { id: user.id }, data: { held: 101 } }))).toMatchObject({
      status: 402,
      body: { code: "INSUFFICIENT_CREDITS" },
    });
  });

  it("a missing parent row becomes 404", async () => {
    expect(await mapFailure(prisma.chat.create({ data: { userId: "nobody" } }))).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
  });

  it("updating a row that is gone becomes 404", async () => {
    expect(await mapFailure(prisma.chat.update({ where: { id: "gone" }, data: { title: "x" } }))).toMatchObject({ status: 404 });
  });

  it("any other unique violation is an unexpected 500 that hides the table and row details", async () => {
    const user = await fixtures.user();
    const data = { userId: user.id, type: "GRANT", amount: 1, reason: "r", idempotencyKey: "same" } as const;
    await prisma.creditLedger.create({ data });
    const mapped = await mapFailure(prisma.creditLedger.create({ data }));
    expect(mapped).toMatchObject({ status: 500, unexpected: true, body: { code: "INTERNAL_ERROR" } });
    expect(JSON.stringify(mapped.body)).not.toMatch(/CreditLedger|idempotencyKey|same/);
  });
});

// Separate clients aimed at a database that is broken in a specific way, so the errors are the real ones.
describe("real database outages", () => {
  const base = "postgresql://magica:magica@localhost";
  async function outcome(url: string, options: Record<string, unknown>, sql: string) {
    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, connectionTimeoutMillis: 2_000, ...options }) });
    try {
      await client.$queryRawUnsafe(sql);
    } catch (error) {
      return toErrorResponse(error);
    } finally {
      await client.$disconnect().catch(() => undefined);
    }
    throw new Error("expected the query to fail");
  }

  it("nothing is listening on the port -> 503", async () => {
    expect(await outcome(`${base}:5999/magica_test`, {}, "SELECT 1")).toMatchObject({ status: 503, body: { code: "SERVICE_UNAVAILABLE" } });
  });

  it("wrong password -> 503 (a misconfigured deployment is our problem, not the caller's)", async () => {
    expect(await outcome("postgresql://magica:wrong@localhost:5432/magica_test", {}, "SELECT 1")).toMatchObject({ status: 503 });
  });

  it("database does not exist -> 503", async () => {
    expect(await outcome(`${base}:5432/does_not_exist`, {}, "SELECT 1")).toMatchObject({ status: 503 });
  });

  it("a statement that exceeds the statement timeout -> 503", async () => {
    expect(await outcome(`${base}:5432/magica_test`, { statement_timeout: 150 }, "SELECT pg_sleep(2)")).toMatchObject({ status: 503 });
  });

  it("a genuine bug in a query (syntax error) is NOT reported as an outage", async () => {
    expect(await outcome(`${base}:5432/magica_test`, {}, "SELEC 1")).toMatchObject({ status: 500, body: { code: "INTERNAL_ERROR" } });
  });
});
