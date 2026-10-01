import { resolve } from "node:path";
import { pino } from "pino";
import { loadSkillRegistry } from "../src/skills/registry.js";

// Checks the agent's skills exactly as the worker loads them: `pnpm skills:check`. Prints what loaded and what was
// rejected (with the reason) and exits non-zero if anything was rejected, so it also works as a CI step.
// SKILLS_DIR overrides the folder (default: agent-skills/ next to this script's project).
const root = resolve(process.env.SKILLS_DIR ?? resolve(import.meta.dirname, "../agent-skills"));
const registry = loadSkillRegistry([root], pino({ level: "silent" }));

console.log(`Skills in ${root}`);
for (const { name, description } of registry.metadata()) {
  const skill = registry.get(name);
  console.log(`  ✔ ${name} (${Buffer.byteLength(skill?.body ?? "")} bytes, sha256 ${skill?.hash.slice(0, 12)}…): ${description}`);
}
for (const { skill, reason } of registry.rejected()) console.log(`  ✘ ${skill}: ${reason}`);
const rejected = registry.rejected().length;
console.log(`${registry.metadata().length} loaded, ${rejected} rejected`);
process.exit(rejected > 0 ? 1 : 0);
