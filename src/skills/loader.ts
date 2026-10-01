import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { prisma, Prisma } from "#src/db/client.js";
import type { SkillRegistry } from "#src/skills/registry.js";
import { skills as defaultSkills } from "#src/skills/skills.js";

// What the agent's skill tools do. Errors carry a message that is safe to hand back to the model (and to show in the
// tool card): never a file system path or an internal detail.

export class SkillToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillToolError";
  }
}

/** Assets are small supporting text files next to SKILL.md. */
export const ASSET_MAX_BYTES = 32_768;
export const ASSET_EXTENSIONS: readonly string[] = [".md", ".txt", ".json"];

export interface LoadedSkill {
  name: string;
  content: string;
  /** sha256 of the content, lowercase hex */
  hash: string;
  /** true when this run had already loaded it: the stored text was returned and nothing was written */
  alreadyLoaded: boolean;
}

interface Deps {
  db?: typeof prisma;
  registry?: SkillRegistry;
}

const unknownSkill = (name: string) => new SkillToolError(`Unknown skill: ${name.slice(0, 64)}`);

/**
 * Gives the run a skill's guidance. The first load records the exact text and its hash on the run; every later load in
 * the same run (or in a retry of it, which inherits the record) gets that stored text back, so the guidance never
 * changes mid-conversation even if the skill file is updated by a deploy.
 */
export async function loadSkill(name: string, agentRunId: string, { db = prisma, registry = defaultSkills() }: Deps = {}): Promise<LoadedSkill> {
  const stored = await db.runSkill.findUnique({ where: { agentRunId_skillName: { agentRunId, skillName: name } } });
  if (stored) return { name, content: stored.content, hash: stored.contentHash, alreadyLoaded: true };

  const skill = registry.get(name);
  if (!skill) throw unknownSkill(name);
  try {
    await db.runSkill.create({ data: { agentRunId, skillName: name, content: skill.body, contentHash: skill.hash } });
  } catch (error) {
    // two loads of the same skill at once in this run: the other one recorded it, so answer with what it stored
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await db.runSkill.findUniqueOrThrow({ where: { agentRunId_skillName: { agentRunId, skillName: name } } });
      return { name, content: winner.content, hash: winner.contentHash, alreadyLoaded: true };
    }
    throw error;
  }
  return { name, content: skill.body, hash: skill.hash, alreadyLoaded: false };
}

export interface SkillAsset {
  skill: string;
  /** the asset's path inside the skill folder, with forward slashes */
  path: string;
  content: string;
}

/**
 * Reads a supporting text file from inside one skill's folder. The path the model gives is checked twice: as written
 * (no absolute paths, nothing that resolves outside the folder) and after following links on disk (a link inside the
 * folder can't point outside it).
 */
export function readSkillAsset(name: string, assetPath: string, { registry = defaultSkills() }: Pick<Deps, "registry"> = {}): SkillAsset {
  const skill = registry.get(name);
  if (!skill) throw unknownSkill(name);

  const invalid = () => new SkillToolError("Invalid asset path.");
  if (!assetPath || assetPath.length > 200 || assetPath.includes("\0") || assetPath.includes("\\") || isAbsolute(assetPath)) throw invalid();

  const target = resolve(skill.dir, assetPath);
  const inside = (path: string, dir: string) => {
    const rel = relative(dir, path);
    // outside means the first segment is "..", not merely a name that starts with two dots
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (!inside(target, skill.dir)) throw invalid();

  const extension = extname(target).toLowerCase();
  if (!ASSET_EXTENSIONS.includes(extension)) throw new SkillToolError(`Unsupported asset type. Allowed: ${ASSET_EXTENSIONS.join(", ")}.`);
  if (target === resolve(skill.dir, "SKILL.md")) throw new SkillToolError("Use load_skill to read a skill's instructions.");

  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    throw new SkillToolError("Asset not found.");
  }
  if (!inside(real, skill.dir)) throw invalid(); // a link that points outside the skill's folder
  const stat = lstatSync(real);
  if (!stat.isFile()) throw new SkillToolError("Asset not found.");
  if (stat.size > ASSET_MAX_BYTES) throw new SkillToolError(`Asset is too large (the limit is ${ASSET_MAX_BYTES / 1024} KB).`);

  return { skill: name, path: relative(skill.dir, target).split(sep).join("/"), content: readFileSync(real, "utf8") };
}
