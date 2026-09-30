import type { ChatMessage, ModelEvent } from "#src/lib/openrouter.js";

// A scriptable stand-in for the model, for testing the agent turn without HTTP. It honours a stop the way the real
// client does: it throws an abort error.
export type Script = (ModelEvent | { wait: number } | { then: () => void | Promise<void> } | { fail: Error })[];

export const text = (delta: string): ModelEvent => ({ type: "text", delta });
export const reasoning = (delta: string): ModelEvent => ({ type: "reasoning", delta });
export const finished = (model: string | null = "provider/free-model", inputTokens = 10, outputTokens = 20, finishReason: string | null = "stop"): ModelEvent => ({
  type: "done",
  model,
  inputTokens,
  outputTokens,
  finishReason,
});

const aborted = () => new DOMException("The operation was aborted", "AbortError");

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(aborted());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(aborted());
      },
      { once: true },
    );
  });

export function fakeModel(script: Script) {
  const calls: { messages: ChatMessage[]; signal: AbortSignal }[] = [];
  const stream = async function* (messages: ChatMessage[], signal: AbortSignal): AsyncGenerator<ModelEvent> {
    calls.push({ messages, signal });
    for (const step of script) {
      if (signal.aborted) throw aborted();
      if ("wait" in step) await pause(step.wait, signal);
      else if ("then" in step) await step.then();
      else if ("fail" in step) throw step.fail;
      else yield step;
    }
  };
  return { stream, calls };
}
