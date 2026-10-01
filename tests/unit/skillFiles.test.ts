import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The skills that ship with the agent. The registry (src/skills) parses and validates them strictly at startup; this
// checks the files themselves, so a broken skill is caught in review rather than at boot.
const root = join(import.meta.dirname, "../../agent-skills");
const skills = readdirSync(root).filter((entry) => statSync(join(root, entry)).isDirectory());

describe("shipped skills", () => {
  it("include at least the three representative skills", () => {
    expect(skills).toEqual(expect.arrayContaining(["image-generation", "image-editing", "video-merging"]));
  });

  it.each(skills)("%s has frontmatter with its own name and a description, then a body under 32 KB", (skill) => {
    const text = readFileSync(join(root, skill, "SKILL.md"), "utf8");
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    expect(match).not.toBeNull();
    const [, frontmatter = "", body = ""] = match ?? [];
    expect(frontmatter).toMatch(new RegExp(`^name: ${skill}$`, "m"));
    expect(frontmatter).toMatch(/^description: .{20,}$/m);
    expect(skill).toMatch(/^[a-z0-9-]+$/);
    expect(body.trim().length).toBeGreaterThan(200);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(32_768);
  });

  it.each(skills)("%s names only tools the agent has", (skill) => {
    const body = readFileSync(join(root, skill, "SKILL.md"), "utf8");
    const mentioned = [...body.matchAll(/\b([a-z]+(?:_[a-z0-9]+)+)\b/g)].map((m) => m[1]).filter((name) => name?.endsWith("_image") || name?.includes("image_") || name?.includes("_videos"));
    for (const tool of mentioned) expect(["gpt_image_2", "crop_image", "merge_videos"]).toContain(tool);
  });
});
