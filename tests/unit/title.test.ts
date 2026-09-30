import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_TITLE, titleFrom } from "#src/lib/title.js";

describe("titleFrom", () => {
  it("uses short text as it is", () => {
    expect(titleFrom("Plan a trip", 50)).toBe("Plan a trip");
  });

  it("collapses every kind of whitespace (newlines, tabs, runs of spaces, non-breaking spaces) into single spaces", () => {
    expect(titleFrom("  Plan\n\n a\ttrip   to\r\nLisbon  ", 50)).toBe("Plan a trip to Lisbon");
  });

  it("cuts long text at the limit with an ellipsis, and does not leave a dangling space before it", () => {
    const title = titleFrom(`${"word ".repeat(30)}`, 12);
    expect(title).toBe("word word wo…");
    expect(titleFrom("abcdefghij kl", 10)).toBe("abcdefghij…"); // the space after the cut is trimmed away
  });

  it("does not add an ellipsis to text that fits exactly", () => {
    expect(titleFrom("x".repeat(50), 50)).toBe("x".repeat(50));
    expect(titleFrom("x".repeat(51), 50)).toBe(`${"x".repeat(50)}…`);
  });

  it("counts whole characters, so emoji and combined characters are never split in half", () => {
    const title = titleFrom("\u{1F642}".repeat(10), 4) ?? "";
    expect(Array.from(title)).toEqual(["\u{1F642}", "\u{1F642}", "\u{1F642}", "\u{1F642}", "…"]);
    expect(title).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/); // no lone half of a surrogate pair
  });

  it("keeps any script as it is", () => {
    expect(titleFrom("日本語のタイトル", 50)).toBe("日本語のタイトル");
    expect(titleFrom("שלום עולם", 50)).toBe("שלום עולם");
  });

  it.each(["", "   ", "\n\t", "​​", "‮", "́", "\u0000", " \u0000 "])("returns null when nothing usable is left: %j", (text) => {
    expect(titleFrom(text, 50)).toBeNull();
  });

  it("removes NUL characters but keeps the rest", () => {
    expect(titleFrom("a\u0000b", 50)).toBe("ab");
  });

  it("never returns more than the limit plus the ellipsis, and always something a user could have typed", () => {
    for (const text of ["x".repeat(500), "\u{1F642}".repeat(500), `${"日".repeat(300)}`]) {
      const title = titleFrom(text, 50) ?? "";
      expect(Array.from(title).length).toBeLessThanOrEqual(51);
      expect(title.length).toBeLessThanOrEqual(200);
    }
  });

  it("matches the default name the database uses", () => {
    expect(DEFAULT_CHAT_TITLE).toBe("New chat");
  });
});
