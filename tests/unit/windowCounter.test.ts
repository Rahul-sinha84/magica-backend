import { describe, expect, it } from "vitest";
import { WindowCounters } from "#src/lib/windowCounter.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const windows = (perMinute: number, perDay: number) => [
  { name: "minute", windowMs: MINUTE, limit: perMinute },
  { name: "day", windowMs: DAY, limit: perDay },
];

describe("WindowCounters", () => {
  it("allows up to the limit in a window, then says which window ran out and when it opens again", () => {
    const counters = new WindowCounters();
    const start = Date.UTC(2026, 9, 2, 12, 0, 10);
    expect(counters.take("k", windows(2, 100), start)).toEqual({ ok: true });
    expect(counters.take("k", windows(2, 100), start + 1)).toEqual({ ok: true });
    expect(counters.take("k", windows(2, 100), start + 2)).toEqual({ ok: false, window: "minute", limit: 2, retryAfterMs: 50_000 - 2 });
    expect(counters.take("k", windows(2, 100), start + 50_000)).toEqual({ ok: true }); // the next minute
  });

  it("doesn't count a refused request against the other windows", () => {
    const counters = new WindowCounters();
    const start = Date.UTC(2026, 9, 2, 12, 0, 0);
    counters.take("k", windows(1, 2), start);
    for (let i = 1; i <= 5; i++) expect(counters.take("k", windows(1, 2), start + i).ok).toBe(false); // the minute is full
    expect(counters.take("k", windows(1, 2), start + MINUTE)).toEqual({ ok: true }); // the day still had room for one
    expect(counters.take("k", windows(1, 2), start + 2 * MINUTE)).toMatchObject({ ok: false, window: "day" });
  });

  it("starts a day window at midnight UTC, and keeps keys apart", () => {
    const counters = new WindowCounters();
    const late = Date.UTC(2026, 9, 2, 23, 59, 59);
    counters.take("a", windows(100, 1), late);
    expect(counters.take("a", windows(100, 1), late + 500)).toMatchObject({ ok: false, window: "day", retryAfterMs: 500 });
    expect(counters.take("b", windows(100, 1), late + 500)).toEqual({ ok: true });
    expect(counters.take("a", windows(100, 1), late + 1000)).toEqual({ ok: true }); // a new UTC day
  });
});
