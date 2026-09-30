import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const HEADER =
  "// Generated from magica-backend/src/contracts by `pnpm contracts:sync` (run in the backend repo). Do not edit by hand.\n";

const tsFiles = (dir: string) => readdirSync(dir).filter((file) => file.endsWith(".ts")).sort();

const normalise = (text: string) => text.replace(/\r\n/g, "\n");

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// `from "./x.js"`, side-effect `import "./x.js"` and dynamic `import("./x.js")`; package imports never match.
const RELATIVE_JS_SPECIFIER = /(\b(?:from|import)\s+["']|\bimport\(\s*["'])(\.{1,2}\/[^"']+)\.js(["'])/g;

/** Node ESM needs `./x.js` specifiers; the frontend's bundler resolution wants `./x`. */
export function toFrontendSource(source: string): string {
  // a BOM would end up in the middle of the file once the header is prepended
  const text = normalise(source).replace(/^\uFEFF/, "");
  return HEADER + text.replace(RELATIVE_JS_SPECIFIER, "$1$2$3");
}

/**
 * Refuses anything that is not plausibly the frontend checkout, so a typo (or a symlink back to this repo)
 * can never overwrite the wrong `contracts/` folder. Returns the resolved real path.
 */
export function assertFrontendRepo(path: string, backendRoot: string): string {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Not a directory: ${path}`);
  const real = realpathSync(path);
  if (real === realpathSync(backendRoot)) throw new Error("That is the backend itself, not the frontend repo.");

  const manifest = join(real, "package.json");
  if (!existsSync(manifest)) throw new Error(`Not a frontend repo (no package.json): ${real}`);
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(manifest, "utf8")) as typeof pkg;
  } catch {
    throw new Error(`Not a frontend repo (package.json is not valid JSON): ${manifest}`);
  }
  if (!pkg.dependencies?.zod && !pkg.devDependencies?.zod) {
    throw new Error(`${real} does not depend on zod, so it cannot use the contracts.`);
  }
  return real;
}

export interface SyncOptions {
  sourceDir: string;
  destDir: string;
  lockFile: string;
}

export interface SyncResult {
  /** Files whose content changed (or that are new) in the destination. */
  changed: string[];
  removed: string[];
  lock: Record<string, string>;
}

/**
 * Copies the contracts into the frontend and writes its lock file in the format its own
 * `contracts:check` reads: `{ "<file>.ts": sha256(text with LF line endings) }`, keys sorted.
 */
export function syncContracts({ sourceDir, destDir, lockFile }: SyncOptions): SyncResult {
  if (!existsSync(sourceDir)) throw new Error(`Contracts source not found: ${sourceDir}`);
  // the frontend's own scripts only read top-level files, so a subfolder would be silently left behind
  const folder = readdirSync(sourceDir, { withFileTypes: true }).find((entry) => entry.isDirectory());
  if (folder) throw new Error(`Contracts must be flat; found a subfolder: ${join(sourceDir, folder.name)}`);
  const files = tsFiles(sourceDir);
  if (files.length === 0) throw new Error(`No .ts contract files in ${sourceDir}`);

  mkdirSync(destDir, { recursive: true });
  const lock: Record<string, string> = {};
  const changed: string[] = [];

  for (const file of files) {
    const text = toFrontendSource(readFileSync(join(sourceDir, file), "utf8"));
    const target = join(destDir, file);
    if (!existsSync(target) || readFileSync(target, "utf8") !== text) changed.push(file);
    writeFileSync(target, text);
    lock[file] = sha256(text);
  }

  // mirror the backend: a contract it deleted must not linger in the frontend
  const removed = tsFiles(destDir).filter((file) => !files.includes(file));
  for (const file of removed) unlinkSync(join(destDir, file));

  writeFileSync(lockFile, JSON.stringify(lock, null, 2) + "\n");
  return { changed, removed, lock };
}
