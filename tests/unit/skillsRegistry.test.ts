import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkillRegistry, parseSkillFile, SKILL_BODY_MAX_BYTES, SkillFileError } from "#src/skills/registry.js";
import { SKILL_ROOTS } from "#src/skills/skills.js";
import { recordingLogger, skillFile, skillTree } from "../helpers/skillTree.js";

const trees: { cleanup: () => void }[] = [];
afterEach(() => {
  for (const tree of trees.splice(0)) tree.cleanup();
});
function tree(files: Record<string, string> = {}) {
  const t = skillTree(files);
  trees.push(t);
  return t;
}
function load(files: Record<string, string>) {
  const t = tree(files);
  const rec = recordingLogger();
  return { registry: loadSkillRegistry([t.root], rec.log), ...rec, root: t.root };
}
/** The reason a single-skill folder was rejected (and that it was not loaded). */
function rejectionOf(name: string, content: string) {
  const { registry, rejected } = load({ [`${name}/SKILL.md`]: content });
  expect(registry.has(name)).toBe(false);
  return rejected().find((r) => r.skill === name)?.reason ?? "not rejected";
}

describe("the shipped skills", () => {
  it("load from agent-skills/ at the project root", () => {
    const registry = loadSkillRegistry(SKILL_ROOTS, recordingLogger().log);
    expect(registry.metadata().map((s) => s.name)).toEqual(expect.arrayContaining(["image-editing", "image-generation", "video-merging"]));
    expect(SKILL_ROOTS).toEqual([resolve(process.cwd(), "agent-skills")]);
  });
});

describe("selective loading: what the model is told up front", () => {
  it("is only names and descriptions, sorted by name, never a body", () => {
    const { registry } = load({ "zeta/SKILL.md": skillFile("zeta", "SECRET-BODY-Z"), "alpha/SKILL.md": skillFile("alpha", "SECRET-BODY-A") });
    expect(registry.metadata()).toEqual([
      { name: "alpha", description: "Guidance for alpha tasks." },
      { name: "zeta", description: "Guidance for zeta tasks." },
    ]);
    expect(JSON.stringify(registry.metadata())).not.toContain("SECRET-BODY");
  });

  it("keeps the body, its sha256 and the folder for when the model asks for it", () => {
    const { registry, root } = load({ "alpha/SKILL.md": skillFile("alpha", "The body.") });
    const skill = registry.get("alpha");
    expect(skill).toMatchObject({ name: "alpha", body: "The body.", hash: createHash("sha256").update("The body.").digest("hex"), dir: expect.stringMatching(/alpha$/) as unknown });
    expect(skill?.dir.endsWith(join(root.split("/").pop() ?? "", "alpha"))).toBe(true);
    expect(registry.has("alpha")).toBe(true);
    expect(registry.has("beta")).toBe(false);
    expect(registry.get("beta")).toBeUndefined();
  });
});

describe("rejected skills (logged, left out, the rest still load)", () => {
  it.each([
    ["no frontmatter", "# Just a body\n\nNo header here.", /--- YAML frontmatter/],
    ["an unterminated frontmatter block", "---\nname: bad\ndescription: Never closed properly here.\n# body", /--- YAML frontmatter/],
    ["frontmatter that is not at the very top", "\n---\nname: bad\ndescription: Not at the top of the file.\n---\nBody", /--- YAML frontmatter/],
    ["invalid YAML", "---\nname: bad\ndescription: [unclosed\n---\nBody", /invalid YAML/],
    ["a YAML list instead of fields", "---\n- name\n- description\n---\nBody", /set of fields/],
    ["duplicate keys", "---\nname: bad\nname: bad\ndescription: Two names in one file here.\n---\nBody", /invalid YAML/],
    ["a missing name", "---\ndescription: No name in this frontmatter.\n---\nBody", /name/],
    ["a missing description", "---\nname: bad\n---\nBody", /description/],
    ["a too-short description", "---\nname: bad\ndescription: Short\n---\nBody", /description/],
    ["a non-string name", "---\nname: 42\ndescription: The name is a number here.\n---\nBody", /name/],
    ["an empty body", "---\nname: bad\ndescription: Nothing after the frontmatter.\n---\n\n   \n", /empty body/],
    ["a YAML custom tag", "---\nname: bad\ndescription: !!js/function 'function () { return 1 }'\n---\nBody", /invalid YAML/],
  ])("rejects %s", (_label, content, reason) => {
    expect(rejectionOf("bad", content)).toMatch(reason);
  });

  it("rejects a ---js block without running it", () => {
    const marker = "__skillCodeRan";
    const content = `---js\n{ name: "bad", description: (globalThis.${marker} = true, "Ran code from frontmatter") }\n---\nBody`;
    expect(rejectionOf("bad", content)).toMatch(/--- YAML frontmatter/);
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });

  it("rejects YAML aliases, so a small file can't expand into a huge one", () => {
    const content = "---\nname: bad\ndescription: &d Anchored description text\nother: *d\n---\nBody";
    expect(rejectionOf("bad", content)).toMatch(/invalid YAML/);
  });

  it("rejects a name that differs from its folder, including only by case", () => {
    expect(rejectionOf("image-tools", skillFile("other-name"))).toMatch(/must match its folder/);
    const { registry, rejected } = load({ "Image-Tools/SKILL.md": skillFile("image-tools") });
    expect(registry.metadata()).toEqual([]);
    expect(rejected()[0]?.reason).toMatch(/lowercase/);
  });

  it("rejects a body larger than 32 KB (measured in bytes) and accepts one at the limit", () => {
    const { registry, rejected } = load({
      "at-limit/SKILL.md": skillFile("at-limit", "a".repeat(SKILL_BODY_MAX_BYTES)),
      "over-limit/SKILL.md": skillFile("over-limit", "é".repeat(SKILL_BODY_MAX_BYTES / 2 + 1)),
    });
    expect(registry.has("at-limit")).toBe(true);
    expect(rejected()).toEqual([{ skill: "over-limit", reason: expect.stringMatching(/larger than 32768 bytes/) as unknown }]);
  });

  it("rejects a file far too large to be a skill without reading it as one", () => {
    expect(rejectionOf("huge", skillFile("huge", "b".repeat(200_000)))).toMatch(/too large/);
  });

  it("rejects a folder with no SKILL.md, a file where a folder should be, and links", () => {
    const t = tree({ "no-file/README.md": "nothing here", "loose-file": "not a folder", "real/SKILL.md": skillFile("real") });
    mkdirSync(join(t.root, "linked-file"));
    symlinkSync(join(t.root, "real", "SKILL.md"), join(t.root, "linked-file", "SKILL.md"));
    symlinkSync(join(t.root, "real"), join(t.root, "linked-folder"));
    const rec = recordingLogger();
    const registry = loadSkillRegistry([t.root], rec.log);
    expect(registry.metadata().map((s) => s.name)).toEqual(["real"]);
    expect(Object.fromEntries(rec.rejected().map((r) => [r.skill, r.reason]))).toEqual({
      "no-file": "has no SKILL.md",
      "loose-file": "not a folder",
      "linked-file": "SKILL.md must be a real file, not a link",
      "linked-folder": "skill folders must be real folders, not links",
    });
  });

  it("keeps loading the other skills when one is bad", () => {
    const { registry, loaded, rejected } = load({ "good-one/SKILL.md": skillFile("good-one"), "bad-one/SKILL.md": "no frontmatter", "good-two/SKILL.md": skillFile("good-two") });
    expect(registry.metadata().map((s) => s.name)).toEqual(["good-one", "good-two"]);
    expect(loaded()).toEqual(["good-one", "good-two"]);
    expect(rejected().map((r) => r.skill)).toEqual(["bad-one"]);
    expect(registry.rejected()).toEqual([{ skill: "bad-one", reason: "must start with a --- YAML frontmatter block" }]);
  });

  it("keeps the first of two skills with the same name in different approved folders", () => {
    const first = tree({ "shared/SKILL.md": skillFile("shared", "First body.") });
    const second = tree({ "shared/SKILL.md": skillFile("shared", "Second body.") });
    const rec = recordingLogger();
    const registry = loadSkillRegistry([first.root, second.root], rec.log);
    expect(registry.get("shared")?.body).toBe("First body.");
    expect(rec.rejected()).toEqual([{ skill: "shared", reason: "a skill with this name is already loaded" }]);
  });
});

describe("tolerated formats", () => {
  it("accepts Windows line endings and a byte-order mark", () => {
    const { registry } = load({ "crlf/SKILL.md": "﻿" + skillFile("crlf", "Line one.\nLine two.").replace(/\n/g, "\r\n") });
    expect(registry.get("crlf")?.body).toBe("Line one.\nLine two.");
  });

  it("ignores extra frontmatter fields", () => {
    const { registry } = load({ "extra/SKILL.md": "---\nname: extra\ndescription: Has more fields than needed.\nversion: 2\nlicense: MIT\n---\nBody" });
    expect(registry.metadata()).toEqual([{ name: "extra", description: "Has more fields than needed." }]);
  });

  it("trims the description and the body", () => {
    const { registry } = load({ "trimmed/SKILL.md": "---\nname: trimmed\ndescription: '   Spaced out description.   '\n---\n\n\n  Body text.  \n\n" });
    expect(registry.get("trimmed")).toMatchObject({ description: "Spaced out description.", body: "Body text." });
  });

  it("skips hidden entries such as .DS_Store", () => {
    const t = tree({ "real/SKILL.md": skillFile("real") });
    writeFileSync(join(t.root, ".DS_Store"), "");
    const rec = recordingLogger();
    expect(loadSkillRegistry([t.root], rec.log).metadata().map((s) => s.name)).toEqual(["real"]);
    expect(rec.rejected()).toEqual([]);
  });
});

describe("startup reporting", () => {
  it("logs each loaded skill with its size and short hash, and the total", () => {
    const { lines } = load({ "alpha/SKILL.md": skillFile("alpha", "Body.") });
    expect(lines.find((l) => l.msg === "skill loaded")).toMatchObject({ skill: "alpha", bytes: 5, hash: expect.stringMatching(/^[0-9a-f]{12}$/) as unknown });
    expect(lines.find((l) => l.msg === "skills ready")).toMatchObject({ count: 1 });
  });

  it("loads nothing, with a warning, when the folder is missing or empty", () => {
    const rec = recordingLogger();
    expect(loadSkillRegistry([join(tree().root, "missing")], rec.log).metadata()).toEqual([]);
    expect(rec.lines.some((l) => l.msg.includes("skills folder not found"))).toBe(true);
    expect(loadSkillRegistry([tree().root], rec.log).metadata()).toEqual([]);
  });
});

describe("parseSkillFile", () => {
  it("returns the frontmatter fields and the trimmed body", () => {
    expect(parseSkillFile("---\nname: a\ndescription: b\n---\n\nHello\n")).toEqual({ frontmatter: { name: "a", description: "b" }, body: "Hello" });
  });

  it("throws a SkillFileError (never something unexpected) for bad input", () => {
    for (const input of ["", "---", "---\n---", "nope"]) expect(() => parseSkillFile(input)).toThrow(SkillFileError);
  });
});
