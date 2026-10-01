import { pino } from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "#src/db/client.js";
import { skills } from "#src/skills/skills.js";
import { agentTools } from "#src/tools/index.js";
import type { ToolContext } from "#src/tools/registry.js";
import { fixtures, resetDb } from "../helpers/db.js";

beforeEach(resetDb);

async function contextForRun(): Promise<ToolContext> {
  const user = await fixtures.user();
  const chat = await fixtures.chat(user.id);
  const run = await fixtures.run(chat.id, user.id);
  return { agentRunId: run.id, chatId: chat.id, userId: user.id, log: pino({ level: "silent" }), signal: new AbortController().signal };
}

describe("load_skill through the agent's tool registry", () => {
  it("gives the model the skill's instructions and records the load on the run", async () => {
    const ctx = await contextForRun();
    const result = await agentTools.execute("load_skill", { name: "image-editing" }, ctx);
    expect(result).toEqual({ ok: true, output: { skill: "image-editing", instructions: skills().get("image-editing")?.body }, assets: [] });
    expect(await prisma.runSkill.findMany({ where: { agentRunId: ctx.agentRunId } })).toEqual([expect.objectContaining({ skillName: "image-editing", contentHash: skills().get("image-editing")?.hash })]);
  });

  it("answers a second load from the record, with one row", async () => {
    const ctx = await contextForRun();
    await agentTools.execute("load_skill", { name: "video-merging" }, ctx);
    expect(await agentTools.execute("load_skill", { name: " video-merging " }, ctx)).toMatchObject({ ok: true, output: { skill: "video-merging" } });
    expect(await prisma.runSkill.count()).toBe(1);
  });

  it("turns an unknown skill into a failed tool result the model can read, writing nothing", async () => {
    const ctx = await contextForRun();
    expect(await agentTools.execute("load_skill", { name: "make-coffee" }, ctx)).toEqual({ ok: false, code: "TOOL_FAILED", message: "Unknown skill: make-coffee" });
    expect(await agentTools.execute("load_skill", {}, ctx)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(await prisma.runSkill.count()).toBe(0);
  });
});

describe("read_skill_asset through the agent's tool registry", () => {
  it("turns a path that escapes the skill, a missing file and a wrong type into safe failed results", async () => {
    const ctx = await contextForRun();
    expect(await agentTools.execute("read_skill_asset", { skill: "image-editing", path: "../video-merging/SKILL.md" }, ctx)).toEqual({ ok: false, code: "TOOL_FAILED", message: "Invalid asset path." });
    expect(await agentTools.execute("read_skill_asset", { skill: "image-editing", path: "presets.md" }, ctx)).toEqual({ ok: false, code: "TOOL_FAILED", message: "Asset not found." });
    expect(await agentTools.execute("read_skill_asset", { skill: "image-editing", path: "run.sh" }, ctx)).toMatchObject({ ok: false, message: expect.stringMatching(/Unsupported asset type/) as unknown });
    expect(await agentTools.execute("read_skill_asset", { skill: "nope", path: "a.md" }, ctx)).toEqual({ ok: false, code: "TOOL_FAILED", message: "Unknown skill: nope" });
  });
});
