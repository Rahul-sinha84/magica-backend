import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type * as Contracts from "#src/contracts/index.js";
import { HEADER, assertFrontendRepo, syncContracts, toFrontendSource } from "../../scripts/lib/syncContracts.js";

// Inside the repo (not os.tmpdir) so `zod` resolves from the project's node_modules, like in the frontend.
const repoRoot = resolve(import.meta.dirname, "../..");
const root = join(repoRoot, "tests/.tmp");
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sourceDir = join(repoRoot, "src/contracts");
let dir: string;
let options: { sourceDir: string; destDir: string; lockFile: string };

beforeEach(() => {
  dir = mkdtempSync(join(root, "fe-"));
  options = { sourceDir, destDir: join(dir, "contracts"), lockFile: join(dir, "contracts.lock.json") };
});

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

describe("toFrontendSource", () => {
  it("drops .js from relative imports and re-exports, including type imports", () => {
    const out = toFrontendSource(
      [
        'import { z } from "zod";',
        'import { A } from "./common.js";',
        'import type { B } from "../other/thing.js";',
        'export * from "./chats.js";',
        "export { C } from './credits.js';",
      ].join("\n"),
    );
    expect(out).toContain('import { z } from "zod";');
    expect(out).toContain('import { A } from "./common";');
    expect(out).toContain('import type { B } from "../other/thing";');
    expect(out).toContain('export * from "./chats";');
    expect(out).toContain("export { C } from './credits';");
    expect(out).not.toMatch(/\.js["']/);
  });

  it("also rewrites side-effect and dynamic imports", () => {
    const out = toFrontendSource('import "./a.js";\nconst m = await import("./b.js");\nvoid import( "../c.js" );\n');
    expect(out).toContain('import "./a";');
    expect(out).toContain('import("./b")');
    expect(out).toContain('import( "../c" )');
  });

  it("strips a BOM instead of leaving it in the middle of the file", () => {
    expect(toFrontendSource("\uFEFFexport const a = 1;\n")).toBe(`${HEADER}export const a = 1;\n`);
  });

  it("handles multi-line imports and namespace re-exports", () => {
    const out = toFrontendSource('import {\n  A,\n  B,\n} from "./common.js";\nexport * as ns from "./chats.js";\n');
    expect(out).toContain('} from "./common";');
    expect(out).toContain('export * as ns from "./chats";');
  });

  it("leaves package imports and unrelated text that mentions .js alone", () => {
    const source = 'import x from "some-lib.js";\n// see ./notes.js for details\nconst s = "./keep.js";\n';
    const out = toFrontendSource(source);
    expect(out).toContain('from "some-lib.js"');
    expect(out).toContain("// see ./notes.js for details");
    expect(out).toContain('const s = "./keep.js";');
  });

  it("prepends the do-not-edit header and normalises CRLF", () => {
    const out = toFrontendSource("a\r\nb\r\n");
    expect(out).toBe(`${HEADER}a\nb\n`);
  });
});

describe("syncContracts", () => {
  it("writes every contract and a lock in the frontend's format", () => {
    const { changed, lock } = syncContracts(options);
    const sources = readdirSync(sourceDir).filter((f) => f.endsWith(".ts")).sort();

    expect(readdirSync(options.destDir).sort()).toEqual(sources);
    expect(changed.sort()).toEqual(sources);
    expect(Object.keys(lock)).toEqual(sources); // sorted keys

    for (const file of sources) {
      expect(lock[file]).toBe(hash(readFileSync(join(options.destDir, file), "utf8")));
    }
    const raw = readFileSync(options.lockFile, "utf8");
    expect(raw).toBe(JSON.stringify(lock, null, 2) + "\n");
  });

  it("is idempotent: a second run changes nothing", () => {
    const first = syncContracts(options);
    const second = syncContracts(options);
    expect(second.changed).toEqual([]);
    expect(second.lock).toEqual(first.lock);
  });

  it("removes a contract that no longer exists in the source, and drops it from the lock", () => {
    syncContracts(options);
    writeFileSync(join(options.destDir, "old.ts"), "export const x = 1;\n");
    const { removed, lock } = syncContracts(options);
    expect(removed).toEqual(["old.ts"]);
    expect(readdirSync(options.destDir)).not.toContain("old.ts");
    expect(lock).not.toHaveProperty("old.ts");
  });

  it("reports only the file that actually changed", () => {
    const src = join(dir, "src");
    mkdirSync(src);
    writeFileSync(join(src, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(src, "b.ts"), "export const b = 1;\n");
    const opts = { ...options, sourceDir: src };

    syncContracts(opts);
    writeFileSync(join(src, "b.ts"), "export const b = 2;\n");
    const { changed, lock } = syncContracts(opts);
    expect(changed).toEqual(["b.ts"]);
    expect(lock["b.ts"]).toBe(hash(`${HEADER}export const b = 2;\n`));
  });

  it("detects hand edits: the lock no longer matches the file", () => {
    const { lock } = syncContracts(options);
    const file = join(options.destDir, "chats.ts");
    writeFileSync(file, readFileSync(file, "utf8") + " ");
    expect(hash(readFileSync(file, "utf8"))).not.toBe(lock["chats.ts"]);
  });

  it("fails clearly when the source is missing or empty", () => {
    expect(() => syncContracts({ ...options, sourceDir: join(dir, "nope") })).toThrow(/not found/);
    const empty = join(dir, "empty");
    mkdirSync(empty);
    expect(() => syncContracts({ ...options, sourceDir: empty })).toThrow(/No \.ts contract files/);
  });

  it("refuses a source with a subfolder instead of silently skipping it", () => {
    const src = join(dir, "src");
    mkdirSync(join(src, "nested"), { recursive: true });
    writeFileSync(join(src, "a.ts"), "export const a = 1;\n");
    expect(() => syncContracts({ ...options, sourceDir: src })).toThrow(/flat.*nested/);
  });

  it("ignores non-.ts files in the source", () => {
    const src = join(dir, "src");
    mkdirSync(src);
    writeFileSync(join(src, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(src, ".DS_Store"), "junk");
    writeFileSync(join(src, "notes.md"), "junk");
    expect(Object.keys(syncContracts({ ...options, sourceDir: src }).lock)).toEqual(["a.ts"]);
  });

  it("only touches .ts files in the destination", () => {
    mkdirSync(options.destDir, { recursive: true });
    writeFileSync(join(options.destDir, "README.md"), "keep me");
    syncContracts(options);
    expect(readFileSync(join(options.destDir, "README.md"), "utf8")).toBe("keep me");
  });
});

describe("synced output works the way the frontend uses it", () => {
  it("type-checks under bundler module resolution with strict mode", () => {
    syncContracts(options);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          // the same settings the frontend's tsconfig.json uses
          target: "ES2017",
          lib: ["dom", "dom.iterable", "esnext"],
          module: "esnext",
          moduleResolution: "bundler",
          isolatedModules: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["contracts/**/*.ts"],
      }),
    );
    expect(() => execFileSync("pnpm", ["exec", "tsc", "-p", join(dir, "tsconfig.json")], { cwd: repoRoot, stdio: "pipe" })).not.toThrow();
  }, 60_000);

  it("loads without file extensions and validates real data", async () => {
    syncContracts(options);
    const contracts = (await import(/* @vite-ignore */ pathToFileURL(join(options.destDir, "index.ts")).href)) as typeof Contracts;
    expect(contracts.SendMessageBodySchema.parse({ content: "hi" })).toEqual({ content: "hi", attachments: [], mode: "default" });
    expect(contracts.foldChunks([{ type: "text-delta", delta: "ok" }])).toEqual([{ type: "text", content: "ok" }]);
  });

  it("leaves no relative .js specifier anywhere in the real contracts", () => {
    syncContracts(options);
    for (const file of readdirSync(options.destDir)) {
      expect(readFileSync(join(options.destDir, file), "utf8")).not.toMatch(/["']\.{1,2}\/[^"']*\.js["']/);
    }
  });

  it("has the do-not-edit header on every file", () => {
    syncContracts(options);
    for (const file of readdirSync(options.destDir)) {
      expect(readFileSync(join(options.destDir, file), "utf8").startsWith(HEADER)).toBe(true);
    }
  });
});

describe("assertFrontendRepo", () => {
  // `null` means "no package.json at all" (a default parameter would swallow `undefined`)
  const frontend = (manifest: unknown = { dependencies: { zod: "^4.0.0" } }) => {
    const repo = mkdtempSync(join(dir, "repo-"));
    if (manifest !== null) writeFileSync(join(repo, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    return repo;
  };

  it("accepts a directory whose package.json depends on zod (dependencies or devDependencies)", () => {
    const a = frontend();
    const b = frontend({ devDependencies: { zod: "^4.0.0" } });
    expect(assertFrontendRepo(a, repoRoot)).toBe(realpathSync(a));
    expect(assertFrontendRepo(b, repoRoot)).toBe(realpathSync(b));
  });

  it("returns the real path when given a symlink to a valid frontend", () => {
    const repo = frontend();
    const link = join(dir, "link-to-frontend");
    symlinkSync(repo, link);
    expect(assertFrontendRepo(link, repoRoot)).toBe(realpathSync(repo));
  });

  it("refuses the backend itself, also through a symlink (this once wrote into the backend repo)", () => {
    expect(() => assertFrontendRepo(repoRoot, repoRoot)).toThrow(/backend itself/);
    const link = join(dir, "link-to-backend");
    symlinkSync(repoRoot, link);
    expect(() => assertFrontendRepo(link, repoRoot)).toThrow(/backend itself/);
  });

  it("refuses a missing path and a plain file", () => {
    expect(() => assertFrontendRepo(join(dir, "nope"), repoRoot)).toThrow(/Not a directory/);
    const file = join(dir, "file.txt");
    writeFileSync(file, "x");
    expect(() => assertFrontendRepo(file, repoRoot)).toThrow(/Not a directory/);
  });

  it("refuses a directory with no package.json, invalid JSON, or no zod", () => {
    expect(() => assertFrontendRepo(frontend(null), repoRoot)).toThrow(/no package\.json/);
    expect(() => assertFrontendRepo(frontend("{ not json"), repoRoot)).toThrow(/not valid JSON/);
    expect(() => assertFrontendRepo(frontend({ name: "something-else" }), repoRoot)).toThrow(/zod/);
  });
});
