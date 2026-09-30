import { describe, expect, it } from "vitest";
import { wellFormed } from "#src/lib/text.js";

describe("wellFormed", () => {
  it("leaves ordinary text, emoji pairs and every script untouched", () => {
    for (const text of ["plain", "\u{1F642}\u{1F680}", "日本語", "שלום", "a\nb\tc", ""]) expect(wellFormed(text)).toBe(text);
  });

  it("replaces a lone high or low surrogate with the replacement character, wherever it is", () => {
    expect(wellFormed("a\ud83db")).toBe("a�b");
    expect(wellFormed("a\ude42b")).toBe("a�b");
    expect(wellFormed("\ud83d")).toBe("�");
    expect(wellFormed("\ude42")).toBe("�");
    expect(wellFormed("\ud83d\ud83d")).toBe("��");
  });

  it("keeps a valid pair next to a lone half", () => {
    expect(wellFormed("\u{1F642}\ud83d")).toBe("\u{1F642}�");
    expect(wellFormed("\ude42\u{1F642}")).toBe("�\u{1F642}");
  });

  it("agrees with the built-in definition of well-formed text", () => {
    for (const text of ["x\ud83d", "\ude42y", "\u{1F642}", "a🙂b", "\ud83d\u{1F642}"]) {
      expect(wellFormed(text)).toBe(text.toWellFormed());
    }
  });
});
