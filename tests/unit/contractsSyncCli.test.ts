import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Runs the real command as a subprocess, from a directory that is NOT the repo, like a user might.
const repoRoot = resolve(import.meta.dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "contracts-cli-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let frontend: string;
beforeEach(() => {
  frontend = mkdtempSync(join(work, "fe-"));
  writeFileSync(join(frontend, "package.json"), JSON.stringify({ dependencies: { zod: "^4.0.0" } }));
});

function sync(path: string) {
  const result = spawnSync("pnpm", ["--dir", repoRoot, "exec", "tsx", "scripts/contracts-sync.ts"], {
    cwd: work,
    env: { ...process.env, FRONTEND_REPO_PATH: path },
    encoding: "utf8",
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

describe("pnpm contracts:sync (subprocess)", () => {
  it("syncs into a frontend even when started from another directory", () => {
    const { status, out } = sync(frontend);
    expect(status).toBe(0);
    const count = readdirSync(join(repoRoot, "src/contracts")).filter((file) => file.endsWith(".ts")).length;
    expect(out).toContain(`${count} contract files in sync (${count} changed)`);
    expect(readdirSync(join(frontend, "contracts"))).toContain("fold.ts");
    expect(existsSync(join(frontend, "contracts.lock.json"))).toBe(true);
  });

  it("reports zero changes on a second run", () => {
    sync(frontend);
    expect(sync(frontend).out).toMatch(/\(0 changed\)/);
  });

  it("fails with a readable message (no stack trace) for a missing path", () => {
    const { status, err } = sync(join(work, "does-not-exist"));
    expect(status).toBe(1);
    expect(err).toContain("contracts:sync failed");
    expect(err).not.toMatch(/\n\s+at /);
  });

  it("refuses the backend through a symlink and writes nothing into it", () => {
    const link = join(work, "backend-link");
    symlinkSync(repoRoot, link);
    const { status, err } = sync(link);
    expect(status).toBe(1);
    expect(err).toContain("backend itself");
    expect(existsSync(join(repoRoot, "contracts"))).toBe(false);
    expect(existsSync(join(repoRoot, "contracts.lock.json"))).toBe(false);
  });

  it("refuses a directory that does not depend on zod, writing nothing", () => {
    const other = join(work, "other");
    mkdirSync(other);
    writeFileSync(join(other, "package.json"), JSON.stringify({ name: "other" }));
    expect(sync(other).status).toBe(1);
    expect(existsSync(join(other, "contracts"))).toBe(false);
  });
});
