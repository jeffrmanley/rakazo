import { describe, expect, it } from "vitest";
import {
  BUDGET_MAX_DAILY_USD,
  budgetLevel,
  budgetNoticeKey,
  checkSpawnLimits,
  dailyCapUsd,
  isPremiumModelId,
  parseBudgetAmount,
  parseLimit,
  resolveBotLimits,
  utcDay,
  utcMonth,
} from "./ext-budget.js";

const defaults = {
  budgetDefaultDailyUsd: 3,
  budgetSpaceDailyUsd: 50,
  maxConcurrentRunsPerBot: 2,
  maxSpawnDepth: 2,
  maxSpawnFanout: 5,
};

describe("utcDay", () => {
  it("is the UTC calendar day, whatever the local offset of the instant", () => {
    const day = utcDay(new Date("2026-10-15T23:59:59.999-00:00"));
    expect(day.key).toBe("2026-10-15");
    expect(day.start.toISOString()).toBe("2026-10-15T00:00:00.000Z");
    expect(day.end.toISOString()).toBe("2026-10-16T00:00:00.000Z");
  });

  it("starts a new day exactly at midnight UTC", () => {
    expect(utcDay(new Date("2026-10-16T00:00:00.000Z")).key).toBe("2026-10-16");
    // 23:30 in New York on the 15th is already the 16th in UTC.
    expect(utcDay(new Date("2026-10-15T23:30:00-04:00")).key).toBe("2026-10-16");
  });

  it("crosses month and year boundaries", () => {
    expect(utcDay(new Date("2026-12-31T12:00:00Z")).end.toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});

describe("utcMonth", () => {
  it("is the UTC calendar month", () => {
    const month = utcMonth(new Date("2026-10-31T23:59:59Z"));
    expect(month.key).toBe("2026-10");
    expect(month.start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(month.end.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(utcMonth(new Date("2026-12-05T00:00:00Z")).end.toISOString()).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });
});

describe("budgetLevel", () => {
  it("warns from 80% and blocks from 100%", () => {
    expect(budgetLevel(2.397, 3)).toBe("ok"); // 79.9%
    expect(budgetLevel(2.4, 3)).toBe("warn"); // 80%
    expect(budgetLevel(2.99, 3)).toBe("warn");
    expect(budgetLevel(3, 3)).toBe("blocked"); // 100%
    expect(budgetLevel(7, 3)).toBe("blocked");
  });

  it("does not trip on floating point dust at the 80% line", () => {
    expect(budgetLevel(0.1 + 0.7, 1)).toBe("warn");
  });

  it("blocks everything under a zero cap", () => {
    expect(budgetLevel(0, 0)).toBe("blocked");
  });
});

describe("dailyCapUsd", () => {
  const settings = { profile: "assistant" as const, customDailyUsd: null };

  it("resolves the profiles, with assistant taken from the environment default", () => {
    expect(dailyCapUsd(null, defaults)).toBe(3);
    expect(dailyCapUsd(settings, { ...defaults, budgetDefaultDailyUsd: 4 })).toBe(4);
    expect(dailyCapUsd({ profile: "worker", customDailyUsd: null }, defaults)).toBe(15);
    expect(dailyCapUsd({ profile: "swarm", customDailyUsd: null }, defaults)).toBe(40);
    expect(dailyCapUsd({ profile: "custom", customDailyUsd: 7.5 }, defaults)).toBe(7.5);
  });

  it("falls back to the default when a custom profile has no amount", () => {
    expect(dailyCapUsd({ profile: "custom", customDailyUsd: null }, defaults)).toBe(3);
  });

  it("adds today's top-ups to the cap", () => {
    expect(dailyCapUsd(settings, defaults, 2.5)).toBe(5.5);
  });
});

describe("parseBudgetAmount", () => {
  it("accepts positive amounts up to the maximum, rounded to cents", () => {
    expect(parseBudgetAmount(10)).toEqual({ ok: true, value: 10 });
    expect(parseBudgetAmount(0.014)).toEqual({ ok: true, value: 0.01 });
    expect(parseBudgetAmount(BUDGET_MAX_DAILY_USD)).toEqual({
      ok: true,
      value: BUDGET_MAX_DAILY_USD,
    });
  });

  it("refuses zero, negatives, non-numbers and amounts above the maximum", () => {
    for (const value of [0, -1, 0.001, Number.NaN, Number.POSITIVE_INFINITY, "5", null, {}]) {
      expect(parseBudgetAmount(value).ok).toBe(false);
    }
    expect(parseBudgetAmount(BUDGET_MAX_DAILY_USD + 0.01).ok).toBe(false);
  });
});

describe("parseLimit", () => {
  it("accepts null (use the default) and small non-negative integers", () => {
    expect(parseLimit(null, 50)).toEqual({ ok: true, value: null });
    expect(parseLimit(0, 50)).toEqual({ ok: true, value: 0 });
    expect(parseLimit(50, 50)).toEqual({ ok: true, value: 50 });
  });

  it("refuses fractions, negatives and values above the bound", () => {
    for (const value of [1.5, -1, 51, "3", Number.NaN]) {
      expect(parseLimit(value, 50).ok).toBe(false);
    }
  });
});

describe("resolveBotLimits", () => {
  it("uses the environment defaults unless the bot overrides them", () => {
    expect(resolveBotLimits(null, defaults)).toEqual({
      maxConcurrentRuns: 2,
      maxSpawnDepth: 2,
      maxSpawnFanout: 5,
    });
    expect(
      resolveBotLimits({ maxConcurrentRuns: 1, maxSpawnDepth: null, maxSpawnFanout: 0 }, defaults),
    ).toEqual({ maxConcurrentRuns: 1, maxSpawnDepth: 2, maxSpawnFanout: 0 });
  });

  it("never lets a bot run with zero concurrency", () => {
    expect(
      resolveBotLimits(
        { maxConcurrentRuns: 0, maxSpawnDepth: null, maxSpawnFanout: null },
        {
          ...defaults,
        },
      ).maxConcurrentRuns,
    ).toBe(1);
    expect(
      resolveBotLimits(null, { ...defaults, maxConcurrentRunsPerBot: 0 }).maxConcurrentRuns,
    ).toBe(1);
  });
});

describe("isPremiumModelId", () => {
  it("matches the Fable and Mythos tiers by id, case-insensitively", () => {
    for (const id of [
      "claude-fable-5",
      "anthropic/claude-fable-5-1",
      "Mythos-1",
      "openrouter/acme/MYTHOS-large",
    ]) {
      expect(isPremiumModelId(id)).toBe(true);
    }
  });

  it("does not match other models", () => {
    for (const id of ["claude-opus-5", "gpt-5", "scripted", "", null, undefined]) {
      expect(isPremiumModelId(id)).toBe(false);
    }
  });
});

describe("checkSpawnLimits", () => {
  const limits = { maxSpawnDepth: 2, maxSpawnFanout: 3 };

  it("allows a delegation within depth and fan-out", () => {
    expect(checkSpawnLimits({ parentDepth: 0, started: 0 }, limits)).toEqual({
      ok: true,
      depth: 1,
    });
    expect(checkSpawnLimits({ parentDepth: 1, started: 2 }, limits)).toEqual({
      ok: true,
      depth: 2,
    });
  });

  it("refuses a delegation deeper than the limit with a message the model can act on", () => {
    const result = checkSpawnLimits({ parentDepth: 2, started: 0 }, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("depth");
      expect(result.error).toMatch(/depth limit \(2\)/);
      expect(result.error).toMatch(/Do the work yourself/);
    }
  });

  it("refuses the delegation after the fan-out limit", () => {
    const result = checkSpawnLimits({ parentDepth: 0, started: 3 }, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("fanout");
      expect(result.error).toMatch(/3 delegations/);
    }
  });

  it("refuses every delegation when a limit is zero", () => {
    expect(
      checkSpawnLimits({ parentDepth: 0, started: 0 }, { maxSpawnDepth: 0, maxSpawnFanout: 5 }).ok,
    ).toBe(false);
    expect(
      checkSpawnLimits({ parentDepth: 0, started: 0 }, { maxSpawnDepth: 2, maxSpawnFanout: 0 }).ok,
    ).toBe(false);
  });
});

describe("budgetNoticeKey", () => {
  it("dedupes daily notices per subject and UTC day", () => {
    const morning = budgetNoticeKey("bot.warn", "bot_1", new Date("2026-10-15T01:00:00Z"));
    const evening = budgetNoticeKey("bot.warn", "bot_1", new Date("2026-10-15T23:00:00Z"));
    const tomorrow = budgetNoticeKey("bot.warn", "bot_1", new Date("2026-10-16T00:00:00Z"));
    expect(morning).toEqual(evening);
    expect(tomorrow.period).not.toBe(morning.period);
    expect(budgetNoticeKey("space.warn", "space_1", new Date("2026-10-15T01:00:00Z")).period).toBe(
      "2026-10-15",
    );
  });

  it("dedupes the monthly alert per calendar month", () => {
    expect(budgetNoticeKey("space.month", "space_1", new Date("2026-10-01T00:00:00Z")).period).toBe(
      "2026-10",
    );
    expect(budgetNoticeKey("space.month", "space_1", new Date("2026-10-31T23:59:59Z")).period).toBe(
      "2026-10",
    );
  });
});
