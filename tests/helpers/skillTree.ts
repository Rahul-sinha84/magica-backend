import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pino } from "pino";

/** A temporary folder of skills for tests. `files` maps relative paths to contents. */
export function skillTree(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "skills-"));
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  for (const [path, content] of Object.entries(files)) write(path, content);
  return { root, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A well-formed SKILL.md. */
export const skillFile = (name: string, body = `# ${name}\n\nUse the tool carefully and explain the result.`, description = `Guidance for ${name} tasks.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

/** A logger that records what it was given, to check what the registry reports. */
export function recordingLogger() {
  const lines: { level: number; msg: string; [key: string]: unknown }[] = [];
  const log = pino({ level: "debug" }, { write: (line: string) => void lines.push(JSON.parse(line) as (typeof lines)[number]) });
  return {
    log,
    lines,
    rejected: () => lines.filter((l) => l.msg === "skill rejected").map((l) => ({ skill: l.skill as string, reason: l.reason as string })),
    loaded: () => lines.filter((l) => l.msg === "skill loaded").map((l) => l.skill as string),
  };
}
