import { describe, expect, it } from "vitest";
import { KnownUsers } from "#src/auth/users.js";

describe("KnownUsers", () => {
  it("remembers users it was told about, and only those", () => {
    const cache = new KnownUsers(10, 1000);
    cache.add("a", 0);
    expect(cache.has("a", 1)).toBe(true);
    expect(cache.has("b", 1)).toBe(false);
  });

  it("forgets a user once its time is up, and frees the slot", () => {
    const cache = new KnownUsers(10, 1000);
    cache.add("a", 0);
    expect(cache.has("a", 999)).toBe(true);
    expect(cache.has("a", 1000)).toBe(false);
    expect(cache.size).toBe(0);
  });

  it("never grows past its limit: the oldest user is dropped first", () => {
    const cache = new KnownUsers(3, 10_000);
    for (const id of ["a", "b", "c", "d", "e"]) cache.add(id, 0);
    expect(cache.size).toBe(3);
    expect([cache.has("a", 1), cache.has("b", 1)]).toEqual([false, false]);
    expect([cache.has("c", 1), cache.has("d", 1), cache.has("e", 1)]).toEqual([true, true, true]);
  });

  it("treats a re-added user as the newest, so active users outlast idle ones", () => {
    const cache = new KnownUsers(3, 10_000);
    for (const id of ["a", "b", "c"]) cache.add(id, 0);
    cache.add("a", 5); // "a" is active again
    cache.add("d", 6); // forces one out: it should be "b", not "a"
    expect([cache.has("a", 7), cache.has("b", 7), cache.has("c", 7), cache.has("d", 7)]).toEqual([true, false, true, true]);
  });

  it("refreshes the expiry when a user is re-added", () => {
    const cache = new KnownUsers(10, 1000);
    cache.add("a", 0);
    cache.add("a", 900);
    expect(cache.has("a", 1500)).toBe(true);
    expect(cache.has("a", 1900)).toBe(false);
  });

  it("does not count a re-added user twice", () => {
    const cache = new KnownUsers(2, 1000);
    for (let i = 0; i < 20; i++) cache.add("same", i);
    expect(cache.size).toBe(1);
  });

  it("supports delete and clear", () => {
    const cache = new KnownUsers(10, 1000);
    cache.add("a", 0);
    cache.add("b", 0);
    cache.delete("a");
    expect(cache.has("a", 1)).toBe(false);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("works with a limit of one", () => {
    const cache = new KnownUsers(1, 1000);
    cache.add("a", 0);
    cache.add("b", 0);
    expect([cache.has("a", 1), cache.has("b", 1)]).toEqual([false, true]);
  });
});
