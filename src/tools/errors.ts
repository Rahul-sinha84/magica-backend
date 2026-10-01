/** Why a tool call failed, in a stable code. */
export type ToolErrorCode = "UNKNOWN_TOOL" | "INVALID_INPUT" | "TOOL_FAILED" | "BAD_OUTPUT";

/** A failure whose message is safe to hand back to the model and to show in the tool card. */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}
