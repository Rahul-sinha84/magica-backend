import { ProposePlanInputSchema, ProposePlanOutputSchema, type PlanPayload } from "#src/contracts/index.js";
import { TOOL_CREDIT_COSTS } from "#src/tools/costs.js";
import { defineTool, ToolError } from "#src/tools/registry.js";

// Plan mode: the agent proposes a plan and waits for the user to approve it (Run All) or ask for changes. Until a plan
// is approved, the turn refuses tools that cost credits (see runTurn).

export const PROPOSE_PLAN = "propose_plan";

/** What the user is asked to approve. The estimates come from the tools' prices, never from the model. */
export function planPayload(input: { title: string; overview: string; steps: { title: string; description?: string; tool?: keyof typeof TOOL_CREDIT_COSTS }[]; notes?: string }): PlanPayload {
  const steps = input.steps.map((step) => ({ ...step, estimatedCredits: step.tool ? TOOL_CREDIT_COSTS[step.tool] : 0 }));
  return {
    title: input.title,
    overview: input.overview,
    steps,
    ...(input.notes && { notes: input.notes }),
    totalCredits: steps.reduce((sum, step) => sum + step.estimatedCredits, 0),
  };
}

export const proposePlanTool = defineTool({
  name: PROPOSE_PLAN,
  description:
    "Plan mode only: show the user your plan and wait for their answer. One step per tool call, in order. Returns whether they approved it (then carry it out) or asked for changes (then revise it and propose again).",
  input: ProposePlanInputSchema,
  output: ProposePlanOutputSchema,
  kind: "inline",
  creditCost: TOOL_CREDIT_COSTS.propose_plan,
  displayResult: (output) => ({ status: output.status, ...(output.feedback !== undefined && { feedback: output.feedback }) }),
  execute: async (input, { waitFor }) => {
    if (!waitFor) throw new ToolError("TOOL_FAILED", "Plans can't be approved right now. Tell the user, and don't use paid tools.");
    const answer = await waitFor("plan", planPayload(input));
    if (answer.status === "approved") {
      return { status: "approved" as const, instruction: "The user approved this plan. Carry it out now, step by step, without asking again." };
    }
    return {
      status: "changes_requested" as const,
      feedback: answer.feedback ?? "",
      instruction: "The user asked for changes (see feedback). Revise the plan and propose it again with propose_plan before using any paid tool.",
    };
  },
});
