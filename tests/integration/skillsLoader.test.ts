import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetryRunResponseSchema } from "#src/contracts/index.js";
import { prisma } from "#src/db/client.js";
import { ASSET_MAX_BYTES, loadSkill, readSkillAsset, SkillToolError } from "#src/skills/loader.js";
import { loadSkillRegistry, type SkillRegistry } from "#src/skills/registry.js";
import { skills } from "#src/skills/skills.js";
import { finalizeRun } from "#src/services/runs.js";
import { as } from "../helpers/app.js";
import { fixtures, resetDb } from "../helpers/db.js";
import { recordingLogger, skillFile, skillTree } from "../helpers/skillTree.js";

beforeEach(resetDb);
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function registryFrom(files: Record<string, string>) {
  const t = skillTree(files);
  cleanups.push(t.cleanup);
  return { registry: loadSkillRegistry([t.root], recordingLogger().log), root: t.root, write: t.write };
}

async function aRun() {
  const user = await fixtures.user();
  const chat = await fixtures.chat(user.id);
  return fixtures.run(chat.id, user.id);
}

const errorOf = async (work: () => unknown) => {
  try {
    await work();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("loadSkill", () => {
  it("returns the body and records the exact text and its hash on the run", async () => {
    const { registry } = registryFrom({ "image-generation/SKILL.md": skillFile("image-generation", "Generate carefully.") });
    const run = await aRun();
    expect(await loadSkill("image-generation", run.id, { registry })).toEqual({ name: "image-generation", content: "Generate carefully.", hash: sha("Generate carefully."), alreadyLoaded: false });
    expect(await prisma.runSkill.findMany()).toEqual([expect.objectContaining({ agentRunId: run.id, skillName: "image-generation", content: "Generate carefully.", contentHash: sha("Generate carefully.") })]);
  });

  it("answers a repeat load from what was stored, writing nothing new", async () => {
    const { registry } = registryFrom({ "image-generation/SKILL.md": skillFile("image-generation", "Generate carefully.") });
    const run = await aRun();
    await loadSkill("image-generation", run.id, { registry });
    const create = vi.spyOn(prisma.runSkill, "create");
    expect(await loadSkill("image-generation", run.id, { registry })).toMatchObject({ content: "Generate carefully.", alreadyLoaded: true });
    expect(create).not.toHaveBeenCalled();
    expect(await prisma.runSkill.count()).toBe(1);
  });

  it("keeps giving the run the text it first loaded, even after the skill file changes (a redeploy)", async () => {
    const before = registryFrom({ "image-generation/SKILL.md": skillFile("image-generation", "Version one.") });
    const run = await aRun();
    await loadSkill("image-generation", run.id, { registry: before.registry });
    const after = registryFrom({ "image-generation/SKILL.md": skillFile("image-generation", "Version two.") });
    expect(await loadSkill("image-generation", run.id, { registry: after.registry })).toMatchObject({ content: "Version one.", hash: sha("Version one."), alreadyLoaded: true });

    const otherRun = await aRun(); // a new run gets the new version
    expect(await loadSkill("image-generation", otherRun.id, { registry: after.registry })).toMatchObject({ content: "Version two.", alreadyLoaded: false });
  });

  it("still serves a loaded skill to its run after the skill is removed", async () => {
    const { registry } = registryFrom({ "image-generation/SKILL.md": skillFile("image-generation", "Kept.") });
    const run = await aRun();
    await loadSkill("image-generation", run.id, { registry });
    const empty: SkillRegistry = { metadata: () => [], has: () => false, get: () => undefined, rejected: () => [] };
    expect(await loadSkill("image-generation", run.id, { registry: empty })).toMatchObject({ content: "Kept." });
  });

  it("records one row when the same skill is loaded several times at once", async () => {
    const { registry } = registryFrom({ "image-generation/SKILL.md": skillFile("image-generation", "Once.") });
    const run = await aRun();
    const results = await Promise.all(Array.from({ length: 6 }, () => loadSkill("image-generation", run.id, { registry })));
    expect(new Set(results.map((r) => r.content))).toEqual(new Set(["Once."]));
    expect(results.filter((r) => !r.alreadyLoaded).length).toBeLessThanOrEqual(1);
    expect(await prisma.runSkill.count()).toBe(1);
  });

  it("records the skill separately for each run", async () => {
    const { registry } = registryFrom({ "image-generation/SKILL.md": skillFile("image-generation") });
    const [a, b] = [await aRun(), await aRun()];
    await loadSkill("image-generation", a.id, { registry });
    await loadSkill("image-generation", b.id, { registry });
    expect(await prisma.runSkill.count()).toBe(2);
  });

  it.each(["no-such-skill", "../image-generation", "image-generation/../../etc", "", "IMAGE-GENERATION", "x".repeat(500)])(
    "refuses an unknown skill (%j) with a safe message and writes nothing",
    async (name) => {
      const { registry } = registryFrom({ "image-generation/SKILL.md": skillFile("image-generation") });
      const run = await aRun();
      const error = await errorOf(() => loadSkill(name, run.id, { registry }));
      expect(error).toBeInstanceOf(SkillToolError);
      expect((error as Error).message).toBe(`Unknown skill: ${name.slice(0, 64)}`);
      expect(await prisma.runSkill.count()).toBe(0);
    },
  );

  it("uses the shipped skills by default", async () => {
    const run = await aRun();
    expect((await loadSkill("image-editing", run.id)).content).toBe(skills().get("image-editing")?.body);
  });
});

describe("durable resume: a retry keeps the guidance of the attempt it retries", () => {
  it("starts the retry with the failed run's loaded skills, text and hash unchanged", async () => {
    const chat = (await as("u1").post("/api/chats").send({})).body as { chat: { id: string } };
    const sent = (await as("u1").post(`/api/chats/${chat.chat.id}/messages`).send({ content: "Draw a fox" })).body as { runId: string };
    const { registry } = registryFrom({ "image-generation/SKILL.md": skillFile("image-generation", "Old guidance.") });
    await loadSkill("image-generation", sent.runId, { registry });
    await finalizeRun(sent.runId, { status: "FAILED", errorCode: "MODEL_EMPTY" });

    const retried = RetryRunResponseSchema.parse((await as("u1").post(`/api/runs/${sent.runId}/retry`)).body);
    expect(await prisma.runSkill.findMany({ where: { agentRunId: retried.runId }, select: { skillName: true, content: true, contentHash: true } })).toEqual([
      { skillName: "image-generation", content: "Old guidance.", contentHash: sha("Old guidance.") },
    ]);
    // and loading it in the retry answers from that record, even though the file now says something else
    const changed = registryFrom({ "image-generation/SKILL.md": skillFile("image-generation", "New guidance.") });
    expect(await loadSkill("image-generation", retried.runId, { registry: changed.registry })).toMatchObject({ content: "Old guidance.", alreadyLoaded: true });
  });

  it("starts with no skills when the retried run had loaded none", async () => {
    const chat = (await as("u1").post("/api/chats").send({})).body as { chat: { id: string } };
    const sent = (await as("u1").post(`/api/chats/${chat.chat.id}/messages`).send({ content: "Hi" })).body as { runId: string };
    await finalizeRun(sent.runId, { status: "FAILED", errorCode: "MODEL_EMPTY" });
    const retried = RetryRunResponseSchema.parse((await as("u1").post(`/api/runs/${sent.runId}/retry`)).body);
    expect(await prisma.runSkill.count({ where: { agentRunId: retried.runId } })).toBe(0);
  });
});

describe("readSkillAsset", () => {
  function withAssets() {
    return registryFrom({
      "image-editing/SKILL.md": skillFile("image-editing"),
      "image-editing/crops.md": "# Crop presets",
      "image-editing/notes.txt": "plain notes",
      "image-editing/presets/sizes.json": '{"square":"1024x1024"}',
      "image-editing/UPPER.MD": "upper-case extension",
      "image-editing/picture.png": "not really a png",
      "image-editing/run.sh": "rm -rf /",
      "image-editing/noextension": "x",
      "video-merging/SKILL.md": skillFile("video-merging"),
      "video-merging/secret.md": "belongs to another skill",
    });
  }

  it("reads text assets inside the skill's folder, including nested ones", () => {
    const { registry } = withAssets();
    expect(readSkillAsset("image-editing", "crops.md", { registry })).toEqual({ skill: "image-editing", path: "crops.md", content: "# Crop presets" });
    expect(readSkillAsset("image-editing", "notes.txt", { registry }).content).toBe("plain notes");
    expect(readSkillAsset("image-editing", "presets/sizes.json", { registry })).toMatchObject({ path: "presets/sizes.json", content: '{"square":"1024x1024"}' });
    expect(readSkillAsset("image-editing", "./presets/../crops.md", { registry }).path).toBe("crops.md");
    expect(readSkillAsset("image-editing", "UPPER.MD", { registry }).content).toBe("upper-case extension");
  });

  it.each([
    ["a parent path", "../video-merging/secret.md"],
    ["a deep parent path", "../../../../etc/passwd"],
    ["a path that climbs back out", "presets/../../video-merging/secret.md"],
    ["an absolute path", "/etc/passwd"],
    ["a backslash path", "..\\video-merging\\secret.md"],
    ["a NUL byte", "crops.md\u0000.png"],
    ["an empty path", ""],
    ["the folder itself", "."],
    ["a very long path", `${"a/".repeat(150)}x.md`],
  ])("refuses %s as an invalid path", (_label, path) => {
    const { registry } = withAssets();
    expect(() => readSkillAsset("image-editing", path, { registry })).toThrow(new SkillToolError("Invalid asset path."));
  });

  it("does not decode URL escapes: an encoded parent path is just a file name that doesn't exist", () => {
    const { registry } = withAssets();
    expect(() => readSkillAsset("image-editing", "..%2f..%2fetc%2fpasswd.md", { registry })).toThrow(new SkillToolError("Asset not found."));
  });

  it("reads a file whose name merely starts with two dots", () => {
    const { registry, write } = withAssets();
    write("image-editing/..notes.md", "dotted name");
    expect(readSkillAsset("image-editing", "..notes.md", { registry })).toMatchObject({ path: "..notes.md", content: "dotted name" });
  });

  it.each(["picture.png", "run.sh", "noextension", "crops.md.js"])("refuses the unsupported file type %j", (path) => {
    const { registry } = withAssets();
    expect(() => readSkillAsset("image-editing", path, { registry })).toThrow(/Unsupported asset type\. Allowed: \.md, \.txt, \.json\./);
  });

  it("points to load_skill for the skill's own SKILL.md", () => {
    const { registry } = withAssets();
    expect(() => readSkillAsset("image-editing", "SKILL.md", { registry })).toThrow(/Use load_skill/);
  });

  it("refuses a link inside the folder that points outside it, and allows one that stays inside", () => {
    const { registry, root } = withAssets();
    symlinkSync(join(root, "video-merging", "secret.md"), join(root, "image-editing", "escape.md"));
    symlinkSync(join(root, "image-editing", "crops.md"), join(root, "image-editing", "alias.md"));
    expect(() => readSkillAsset("image-editing", "escape.md", { registry })).toThrow(new SkillToolError("Invalid asset path."));
    expect(readSkillAsset("image-editing", "alias.md", { registry }).content).toBe("# Crop presets");
  });

  it("refuses an asset over 32 KB and reads one at the limit", () => {
    const { registry, write } = withAssets();
    write("image-editing/at-limit.txt", "a".repeat(ASSET_MAX_BYTES));
    write("image-editing/too-big.txt", "a".repeat(ASSET_MAX_BYTES + 1));
    expect(readSkillAsset("image-editing", "at-limit.txt", { registry }).content).toHaveLength(ASSET_MAX_BYTES);
    expect(() => readSkillAsset("image-editing", "too-big.txt", { registry })).toThrow(/too large/);
  });

  it("reports a missing asset or a folder named like a file as not found", () => {
    const { registry, root } = withAssets();
    mkdirSync(join(root, "image-editing", "folder.md"));
    expect(() => readSkillAsset("image-editing", "missing.md", { registry })).toThrow(new SkillToolError("Asset not found."));
    expect(() => readSkillAsset("image-editing", "folder.md", { registry })).toThrow(new SkillToolError("Asset not found."));
  });

  it("refuses an unknown skill", () => {
    const { registry } = withAssets();
    expect(() => readSkillAsset("nope", "crops.md", { registry })).toThrow(new SkillToolError("Unknown skill: nope"));
  });

  it("never reveals a file system path in its errors", () => {
    const { registry, root } = withAssets();
    writeFileSync(join(root, "image-editing", "huge.md"), "a".repeat(ASSET_MAX_BYTES + 10));
    for (const path of ["../video-merging/secret.md", "/etc/passwd", "missing.md", "huge.md", "picture.png"]) {
      try {
        readSkillAsset("image-editing", path, { registry });
      } catch (error) {
        expect((error as Error).message).not.toContain(root);
        expect((error as Error).message).not.toMatch(/\/(tmp|var|private|Users)\//);
      }
    }
  });
});
