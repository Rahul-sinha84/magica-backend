import { MAGICA_TOOLS } from "#src/tools/magicaTools.js";
import { createToolRegistry, type ToolRegistry } from "#src/tools/registry.js";
import { loadSkillTool, readSkillAssetTool } from "#src/tools/skillTools.js";

// The agent's tools. A new tool is a new definition added here; nothing else in the agent changes.
export const agentTools: ToolRegistry = createToolRegistry([loadSkillTool, readSkillAssetTool, ...MAGICA_TOOLS]);
