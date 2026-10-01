import { LoadSkillInputSchema, LoadSkillOutputSchema, ReadSkillAssetInputSchema, ReadSkillAssetOutputSchema } from "#src/contracts/index.js";
import { loadSkill, readSkillAsset } from "#src/skills/loader.js";
import { TOOL_CREDIT_COSTS } from "#src/tools/costs.js";
import { defineTool } from "#src/tools/registry.js";

// The skill tools: how the model gets a skill's full guidance (and supporting files) only when it needs them.

export const loadSkillTool = defineTool({
  name: "load_skill",
  description: "Load the full instructions of one of the available skills. Do this before using a tool the skill covers.",
  input: LoadSkillInputSchema,
  output: LoadSkillOutputSchema,
  kind: "inline",
  creditCost: TOOL_CREDIT_COSTS.load_skill,
  // the model gets the whole guidance; the tool card only needs to say which skill was loaded
  displayResult: (output) => ({ skill: output.skill, loaded: true }),
  execute: async ({ name }, { agentRunId }) => {
    const skill = await loadSkill(name, agentRunId);
    return { skill: skill.name, instructions: skill.content };
  },
});

export const readSkillAssetTool = defineTool({
  name: "read_skill_asset",
  description: "Read a supporting text file (.md, .txt or .json) that a loaded skill refers to.",
  input: ReadSkillAssetInputSchema,
  output: ReadSkillAssetOutputSchema,
  kind: "inline",
  creditCost: TOOL_CREDIT_COSTS.read_skill_asset,
  displayResult: (output) => ({ skill: output.skill, path: output.path, characters: output.content.length }),
  execute: ({ skill, path }) => Promise.resolve(readSkillAsset(skill, path)),
});
