import { describe, expect, it } from "vitest";
import { FAILURE_INFO } from "#src/lib/openrouter.js";
import { judgeHealth, MODEL_FAILURE_CODES } from "#src/services/models.js";

const ok = (model = "meta/free-7b") => ({ status: "COMPLETED", errorCode: null, model });
const modelFail = (errorCode = "MODEL_RATE_LIMITED") => ({ status: "FAILED", errorCode, model: null });
const otherFail = (errorCode = "AGENT_CRASHED") => ({ status: "FAILED", errorCode, model: null });

describe("judgeHealth (newest first)", () => {
  it("is unknown with no recent turns", () => {
    expect(judgeHealth([])).toEqual({ health: "unknown", lastRoutedModel: null, reason: null });
  });

  it("is available when recent turns answered", () => {
    expect(judgeHealth([ok("a/free"), ok("b/free")])).toEqual({ health: "available", lastRoutedModel: "a/free", reason: null });
  });

  it("is degraded when some recent turns failed because of the model", () => {
    expect(judgeHealth([ok(), modelFail(), ok()]).health).toBe("degraded");
    expect(judgeHealth([modelFail(), modelFail(), ok()]).health).toBe("degraded"); // only two in a row
  });

  it("is unavailable when the latest three turns all failed because of the model", () => {
    expect(judgeHealth([modelFail("MODEL_UNAVAILABLE"), modelFail(), modelFail("MODEL_EMPTY"), ok("x/free")])).toEqual({ health: "unavailable", lastRoutedModel: "x/free", reason: null });
  });

  it("recovers as soon as the latest turn answers again", () => {
    expect(judgeHealth([ok(), modelFail(), modelFail(), modelFail()]).health).toBe("degraded");
  });

  it("treats a wrong key (MODEL_CONFIG) as the model being unavailable", () => {
    expect(judgeHealth([modelFail("MODEL_CONFIG"), modelFail("MODEL_CONFIG"), modelFail("MODEL_CONFIG")]).health).toBe("unavailable");
  });

  it("ignores failures that say nothing about the model (crashes, time-outs, interrupted streams)", () => {
    expect(judgeHealth([otherFail(), otherFail("AGENT_TIMEOUT"), otherFail("MODEL_INTERRUPTED")]).health).toBe("unknown");
    expect(judgeHealth([otherFail(), otherFail(), otherFail(), ok()]).health).toBe("available");
    expect(judgeHealth([modelFail(), otherFail(), modelFail(), otherFail(), modelFail()]).health).toBe("unavailable");
  });

  it("ignores a failure with no code", () => {
    expect(judgeHealth([{ status: "FAILED", errorCode: null, model: null }, ok()]).health).toBe("available");
  });

  it("reports the model of the latest answered turn, skipping turns with none recorded", () => {
    expect(judgeHealth([modelFail(), { status: "COMPLETED", errorCode: null, model: null }, ok("older/free")]).lastRoutedModel).toBe("older/free");
  });

  describe("the free daily limit", () => {
    const now = Date.UTC(2026, 9, 2, 15, 0); // 15:00 UTC
    const daily = (completedAt: Date | null = new Date(now - 60_000)) => ({ status: "FAILED", errorCode: "MODEL_DAILY_LIMIT", model: null, completedAt });

    it("makes the model unavailable at once, with a reason that says when it resets", () => {
      expect(judgeHealth([daily(), ok("a/free")], now)).toEqual({ health: "unavailable", lastRoutedModel: "a/free", reason: FAILURE_INFO.DAILY_LIMIT.message });
    });

    it("recovers as soon as a turn answers again (the limit has reset)", () => {
      expect(judgeHealth([ok("b/free"), daily()], now)).toMatchObject({ health: "degraded", reason: null });
    });

    it("ignores a daily-limit failure from before the last reset at 00:00 UTC", () => {
      const yesterday = new Date(Date.UTC(2026, 9, 1, 23, 59));
      expect(judgeHealth([daily(yesterday)], now)).toEqual({ health: "unknown", lastRoutedModel: null, reason: null });
      expect(judgeHealth([daily(yesterday), ok()], now)).toMatchObject({ health: "available", reason: null });
    });

    it("counts one exactly at the reset as today's", () => {
      expect(judgeHealth([daily(new Date(Date.UTC(2026, 9, 2, 0, 0)))], now).health).toBe("unavailable");
    });

    it("is not hidden by unrelated failures after it", () => {
      expect(judgeHealth([otherFail(), otherFail("MODEL_INTERRUPTED"), daily()], now).reason).toBe(FAILURE_INFO.DAILY_LIMIT.message);
    });
  });

  it("only counts codes the model client really produces", () => {
    const real = Object.values(FAILURE_INFO).map((info) => info.code);
    for (const code of MODEL_FAILURE_CODES) expect(real).toContain(code);
  });
});
