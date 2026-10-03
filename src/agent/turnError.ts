// Env-free, so the tool registry (shared with the API) can tell a turn-ending error from a tool's own failure.

/** A failure of our own making, carrying the words that are safe to show. Thrown from a tool, it ends the turn. */
export class TurnError extends Error {
  constructor(
    readonly code: string,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = "TurnError";
  }
}
