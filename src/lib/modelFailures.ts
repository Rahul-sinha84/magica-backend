// Why the model could not answer, shared by the worker (which produces these) and the API (whose model status reads
// them back from ended runs). Kept free of any environment, so the API can import it without the worker's settings.

/** Why the model could not answer, in terms of what the user can do about it. */
export type ModelFailure = "RATE_LIMITED" | "DAILY_LIMIT" | "UNAVAILABLE" | "EMPTY" | "INTERRUPTED" | "REJECTED" | "CONFIG";

// Stable codes for the run row, and wording that is safe to show to the user (nothing about providers or keys).
export const FAILURE_INFO: Readonly<Record<ModelFailure, { code: string; message: string }>> = {
  RATE_LIMITED: { code: "MODEL_RATE_LIMITED", message: "The free model is busy right now. Please try again in a moment." },
  DAILY_LIMIT: { code: "MODEL_DAILY_LIMIT", message: "The free model's daily limit is reached. It resets at 00:00 UTC." },
  UNAVAILABLE: { code: "MODEL_UNAVAILABLE", message: "The assistant is unavailable right now. Please try again shortly." },
  EMPTY: { code: "MODEL_EMPTY", message: "The assistant didn't return an answer. Please try again." },
  INTERRUPTED: { code: "MODEL_INTERRUPTED", message: "The response was interrupted. What was written so far is kept." },
  REJECTED: { code: "MODEL_REJECTED", message: "The assistant couldn't process this conversation." },
  CONFIG: { code: "MODEL_CONFIG", message: "The assistant isn't available right now." },
};
