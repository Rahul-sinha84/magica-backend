import { resolve } from "node:path";
import { logger } from "#src/lib/logger.js";
import { loadSkillRegistry, type SkillRegistry } from "#src/skills/registry.js";

/** The approved skills folder: `agent-skills/` at the project root (and next to the worker in a Trigger.dev deploy). */
export const SKILL_ROOTS = [resolve(process.cwd(), "agent-skills")];

let registry: SkillRegistry | undefined;

/** The worker's skills, read and checked once, on first use. */
export function skills(): SkillRegistry {
  registry ??= loadSkillRegistry(SKILL_ROOTS, logger);
  return registry;
}
