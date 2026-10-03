import type { WaitTokens } from "#src/waitpoints/wait.js";
import { trigger } from "./triggerMock.js";

type Outcome = { ok: true; output: unknown } | { ok: false };

interface Token {
  id: string;
  key: string;
  timeout: Date;
  tags: string[];
  outcome: Outcome | null;
  wake: ((outcome: Outcome) => void) | null;
}

/**
 * Stands in for Trigger.dev's waitpoint tokens, the way they behave where it matters: the same idempotency key gives
 * the same token; a wait ends when the token is completed (through the API's answer, wired to the Trigger.dev mock, or
 * directly) or times out; a token that is already done answers at once; completing a done token changes nothing.
 */
export function fakeTokens() {
  const tokens = new Map<string, Token>();
  const byKey = new Map<string, string>();
  let waiters: (() => void)[] = [];

  const settle = (id: string, outcome: Outcome) => {
    const token = tokens.get(id);
    if (!token || token.outcome) return false;
    token.outcome = outcome;
    token.wake?.(outcome);
    return true;
  };

  const waitTokens: WaitTokens = {
    create: ({ idempotencyKey, timeout, tags }) => {
      const existing = byKey.get(idempotencyKey);
      if (existing) return Promise.resolve({ id: existing });
      const id = `waitpoint_${tokens.size + 1}`;
      tokens.set(id, { id, key: idempotencyKey, timeout, tags, outcome: null, wake: null });
      byKey.set(idempotencyKey, id);
      return Promise.resolve({ id });
    },
    wait: (id) => {
      const token = tokens.get(id);
      if (!token) return Promise.reject(new Error(`no such token: ${id}`));
      if (token.outcome) return Promise.resolve(token.outcome);
      const waiting = new Promise<Outcome>((resolve) => (token.wake = resolve));
      for (const notify of waiters.splice(0)) notify();
      return waiting;
    },
  };

  // the API's answers (through the Trigger.dev mock) complete these tokens
  trigger.onTokenCompleted = (id, output) => void settle(id, { ok: true, output });

  return {
    tokens: waitTokens,
    all: () => [...tokens.values()],
    /** Completes a token directly (as if the answer reached Trigger.dev but nothing else happened). */
    complete: (id: string, output: unknown) => settle(id, { ok: true, output }),
    /** The token's timeout passes. */
    timeOut: (id: string) => settle(id, { ok: false }),
    /** Resolves once a run is waiting on a token (immediately if one already is). */
    someoneWaiting: () =>
      new Promise<void>((resolve) => {
        if ([...tokens.values()].some((token) => token.wake && !token.outcome)) resolve();
        else waiters.push(resolve);
      }),
    reset: () => {
      tokens.clear();
      byKey.clear();
      waiters = [];
    },
  };
}
