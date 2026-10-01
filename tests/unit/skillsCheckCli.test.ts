import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { skillFile, skillTree } from "../helpers/skillTree.js";

// `pnpm skills:check`, run as a real process. It must not need the app's environment (no database, no keys).
const repoRoot = resolve(import.meta.dirname, "../..");
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function check(files: Record<string, string>) {
  const tree = skillTree(files);
  cleanups.push(tree.cleanup);
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SKILLS_DIR: tree.root };
  const result = spawnSync("pnpm", ["--dir", repoRoot, "--silent", "skills:check"], { encoding: "utf8", env, timeout: 60_000 });
  return { code: result.status, out: result.stdout };
}

describe("pnpm skills:check", () => {
  it("lists every skill and exits 0 when all are valid, without any app environment", () => {
    const { code, out } = check({ "alpha/SKILL.md": skillFile("alpha"), "beta/SKILL.md": skillFile("beta") });
    expect(code).toBe(0);
    expect(out).toMatch(/✔ alpha \(\d+ bytes, sha256 [0-9a-f]{12}…\): Guidance for alpha tasks\./);
    expect(out).toContain("2 loaded, 0 rejected");
  }, 70_000);

  it("names each rejected skill with its reason and exits 1", () => {
    const { code, out } = check({ "alpha/SKILL.md": skillFile("alpha"), "broken/SKILL.md": "hello" });
    expect(code).toBe(1);
    expect(out).toContain("✘ broken: must start with a --- YAML frontmatter block");
    expect(out).toContain("1 loaded, 1 rejected");
  }, 70_000);
});
