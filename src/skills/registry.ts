import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Logger } from "pino";
import { parseDocument } from "yaml";
import { z } from "zod";

// Skills are application-owned guidance: `<root>/<name>/SKILL.md`, YAML frontmatter (name, description) then a Markdown
// body. They are read and checked once, when the worker starts, so a bad skill is reported at boot and never reaches
// the model. Only names and descriptions go into the prompt; the body is handed over when the model asks for it.

/** A skill body has to fit the model's context window alongside the conversation. */
export const SKILL_BODY_MAX_BYTES = 32_768;
// the frontmatter is a few lines; anything much larger than the body cap is not a skill file
const SKILL_FILE_MAX_BYTES = SKILL_BODY_MAX_BYTES + 4_096;
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const FrontmatterSchema = z.object({
  name: z.string().max(64).regex(SKILL_NAME, { error: "must be lowercase letters, digits and single hyphens" }),
  description: z.string().trim().min(10).max(500),
});

export interface Skill {
  name: string;
  description: string;
  body: string;
  /** sha256 of the body, lowercase hex */
  hash: string;
  /** absolute, symlink-free path of the skill's folder (assets are only read from inside it) */
  dir: string;
}

export interface SkillMetadata {
  name: string;
  description: string;
}

export interface SkillRegistry {
  /** What the model is told about: names and descriptions only, never a body. Sorted by name. */
  metadata(): SkillMetadata[];
  has(name: string): boolean;
  get(name: string): Skill | undefined;
  /** Skills that failed a check at startup, with the reason (also logged). */
  rejected(): { skill: string; reason: string }[];
}

export class SkillFileError extends Error {}

/** Splits a SKILL.md into its frontmatter and body. Only a plain `---` YAML block is accepted (never `---js` or similar). */
export function parseSkillFile(raw: string): { frontmatter: unknown; body: string } {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new SkillFileError("must start with a --- YAML frontmatter block");
  const [, yaml = "", body = ""] = match;
  // Plain YAML only: duplicate keys, aliases and unknown tags (the library would otherwise keep an unknown tag's value
  // as text, with only a warning) are all rejected rather than guessed at.
  const doc = parseDocument(yaml, { strict: true, uniqueKeys: true, prettyErrors: false });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) throw new SkillFileError(`has invalid YAML frontmatter (${problem.message.split("\n")[0]})`);
  let frontmatter: unknown;
  try {
    frontmatter = doc.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new SkillFileError(`has invalid YAML frontmatter (${error instanceof Error ? error.message.split("\n")[0] : "unreadable"})`);
  }
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) throw new SkillFileError("frontmatter must be a set of fields");
  return { frontmatter, body: body.trim() };
}

function readSkill(folder: string, dir: string): Skill {
  const file = join(dir, "SKILL.md");
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    throw new SkillFileError("has no SKILL.md");
  }
  if (stat.isSymbolicLink()) throw new SkillFileError("SKILL.md must be a real file, not a link");
  if (!stat.isFile()) throw new SkillFileError("SKILL.md is not a file");
  if (stat.size > SKILL_FILE_MAX_BYTES) throw new SkillFileError(`SKILL.md is too large (${stat.size} bytes)`);

  const { frontmatter, body } = parseSkillFile(readFileSync(file, "utf8"));
  const fields = FrontmatterSchema.safeParse(frontmatter);
  if (!fields.success) throw new SkillFileError(`has invalid frontmatter: ${fields.error.issues.map((i) => `${i.path.join(".") || "field"} ${i.message}`).join("; ")}`);
  if (fields.data.name !== folder) throw new SkillFileError(`frontmatter name "${fields.data.name}" must match its folder "${folder}"`);
  if (!body) throw new SkillFileError("has an empty body");
  if (Buffer.byteLength(body) > SKILL_BODY_MAX_BYTES) throw new SkillFileError(`body is larger than ${SKILL_BODY_MAX_BYTES} bytes`);

  return { name: fields.data.name, description: fields.data.description, body, hash: createHash("sha256").update(body).digest("hex"), dir };
}

/**
 * Reads every skill under the approved roots. A skill that fails a check is logged and left out; the rest still load.
 * The same name in two roots keeps the first and rejects the later one.
 */
export function loadSkillRegistry(roots: string[], log: Logger): SkillRegistry {
  const skills = new Map<string, Skill>();
  const rejections: { skill: string; reason: string }[] = [];
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      log.warn({ root }, "skills folder not found; no skills loaded from it");
      continue;
    }
    const realRoot = realpathSync(root);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue; // .DS_Store and friends
      const reject = (reason: string) => {
        rejections.push({ skill: entry.name, reason });
        log.warn({ skill: entry.name, root, reason }, "skill rejected");
      };
      if (entry.isSymbolicLink()) {
        reject("skill folders must be real folders, not links");
        continue;
      }
      if (!entry.isDirectory()) {
        reject("not a folder");
        continue;
      }
      if (!SKILL_NAME.test(entry.name)) {
        reject("folder name must be lowercase letters, digits and single hyphens");
        continue;
      }
      if (skills.has(entry.name)) {
        reject("a skill with this name is already loaded");
        continue;
      }
      try {
        const skill = readSkill(entry.name, resolve(realRoot, entry.name));
        skills.set(skill.name, skill);
        log.info({ skill: skill.name, bytes: Buffer.byteLength(skill.body), hash: skill.hash.slice(0, 12) }, "skill loaded");
      } catch (error) {
        if (!(error instanceof SkillFileError)) throw error; // a real I/O problem, not a bad skill
        reject(error.message);
      }
    }
  }
  log.info({ count: skills.size }, "skills ready");

  const sorted = [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    metadata: () => sorted.map(({ name, description }) => ({ name, description })),
    has: (name) => skills.has(name),
    get: (name) => skills.get(name),
    rejected: () => rejections.map((r) => ({ ...r })),
  };
}
