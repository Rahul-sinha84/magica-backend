import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "#src/lib/errors.js";
import { CursorTimestampSchema, decodeCursor, encodeCursor } from "#src/lib/cursor.js";

const Schema = z.tuple([z.union([z.literal(0), z.literal(1)]), CursorTimestampSchema, z.string().min(1).max(64)]);
const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a sort key, including millisecond precision", () => {
    const cursor = encodeCursor([1, "2026-09-30T13:45:12.345Z", "chat_abc"]);
    const [pinned, at, id] = decodeCursor(cursor, Schema);
    expect([pinned, at.toISOString(), id]).toEqual([1, "2026-09-30T13:45:12.345Z", "chat_abc"]);
  });

  it("produces URL-safe text (no +, / or =) that fits the contract's 512-character limit", () => {
    const cursor = encodeCursor([0, "2026-09-30T13:45:12.345Z", "x".repeat(64)]);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor.length).toBeLessThanOrEqual(512);
  });

  it("does not reveal anything readable about the row (it is opaque, not a bare id)", () => {
    expect(encodeCursor([0, "2026-09-30T13:45:12.345Z", "chat_abc"])).not.toContain("chat_abc");
  });

  describe("rejects a malformed or tampered cursor with a 400, never a crash", () => {
    const bad: [string, string][] = [
      ["empty", ""],
      ["not base64", "!!!***"],
      ["base64 of text, not JSON", b64("hello")],
      ["base64 of JSON null", b64("null")],
      ["an object instead of a tuple", b64({ pinned: 1 })],
      ["too few items", b64([0, "2026-09-30T13:45:12.345Z"])],
      ["too many items", b64([0, "2026-09-30T13:45:12.345Z", "id", "extra"])],
      ["pinned flag out of range", b64([2, "2026-09-30T13:45:12.345Z", "id"])],
      ["pinned flag as a boolean", b64([true, "2026-09-30T13:45:12.345Z", "id"])],
      ["timestamp not a date", b64([0, "yesterday", "id"])],
      ["timestamp as a number", b64([0, 1_700_000_000_000, "id"])],
      ["timestamp with an offset", b64([0, "2026-09-30T13:45:12.345+05:30", "id"])],
      ["timestamp in year 0000 (the database rejects it)", b64([0, "0000-01-01T00:00:00.000Z", "id"])],
      ["timestamp far in the future", b64([0, "9999-12-31T23:59:59.999Z", "id"])],
      ["id empty", b64([0, "2026-09-30T13:45:12.345Z", ""])],
      ["id too long", b64([0, "2026-09-30T13:45:12.345Z", "x".repeat(65)])],
      ["id not a string", b64([0, "2026-09-30T13:45:12.345Z", 42])],
      ["truncated", encodeCursor([0, "2026-09-30T13:45:12.345Z", "id"]).slice(0, -6)],
    ];

    it.each(bad)("%s", (_label, cursor) => {
      const thrown = (() => {
        try {
          decodeCursor(cursor, Schema);
        } catch (error) {
          return error;
        }
      })();
      expect(thrown).toBeInstanceOf(AppError);
      expect(thrown).toMatchObject({ code: "VALIDATION_FAILED", status: 400, details: { fields: { cursor: expect.any(Array) as unknown } } });
    });

    it("gives the same generic message every time, never echoing what was sent", () => {
      const secret = "SECRET-VALUE-123";
      try {
        decodeCursor(b64([9, secret, secret]), Schema);
      } catch (error) {
        expect(JSON.stringify((error as AppError).details) + (error as AppError).message).not.toContain(secret);
      }
    });
  });
});

describe("CursorTimestampSchema", () => {
  it.each(["2000-01-01T00:00:00.000Z", "2026-09-30T13:45:12.345Z", "2199-12-31T23:59:59.999Z"])("accepts %s", (value) => {
    expect(CursorTimestampSchema.parse(value).toISOString()).toBe(value);
  });

  it.each(["1999-12-31T23:59:59.999Z", "2200-01-01T00:00:00.000Z", "0000-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"])("rejects %s", (value) => {
    expect(CursorTimestampSchema.safeParse(value).success).toBe(false);
  });
});
