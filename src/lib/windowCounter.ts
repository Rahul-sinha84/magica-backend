// Fixed-window request counters, in memory. Correct for one instance; with several instances each counts its own
// requests, and a restart starts fresh (the same documented trade-off as the API's other rate limits).

export interface Window {
  /** a name for the window, reported when it is the one that ran out ("minute", "day") */
  name: string;
  windowMs: number;
  limit: number;
}

export type Take = { ok: true } | { ok: false; window: string; limit: number; retryAfterMs: number };

const MAX_ENTRIES = 100_000;

export class WindowCounters {
  private readonly counts = new Map<string, { start: number; count: number }>();

  /**
   * Counts one request for `key` in every window, or none of them if any is full (so a refused request doesn't use up
   * the others). Windows are aligned to the epoch: a day window is a UTC day.
   */
  take(key: string, windows: readonly Window[], now = Date.now()): Take {
    const current = windows.map((window) => {
      const start = Math.floor(now / window.windowMs) * window.windowMs;
      const id = `${key}|${window.name}`;
      const entry = this.counts.get(id);
      return { window, id, start, count: entry && entry.start === start ? entry.count : 0 };
    });
    const full = current.find(({ window, count }) => count >= window.limit);
    if (full) return { ok: false, window: full.window.name, limit: full.window.limit, retryAfterMs: full.start + full.window.windowMs - now };
    if (this.counts.size > MAX_ENTRIES) this.forgetEnded(now, windows);
    for (const { id, start, count } of current) this.counts.set(id, { start, count: count + 1 });
    return { ok: true };
  }

  private forgetEnded(now: number, windows: readonly Window[]): void {
    const longest = Math.max(...windows.map((window) => window.windowMs));
    for (const [id, entry] of this.counts) if (entry.start + longest <= now) this.counts.delete(id);
    if (this.counts.size > MAX_ENTRIES) this.counts.clear(); // still too many: start over rather than grow without bound
  }
}
