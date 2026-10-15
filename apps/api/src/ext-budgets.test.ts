import { describe, expect, it } from "vitest";
import { parseBotPatch, raisesBudget } from "./ext-budgets.js";

describe("parseBotPatch", () => {
  it("keeps only known fields, so a spaceId or botId in the body is ignored", () => {
    expect(
      parseBotPatch({ profile: "worker", spaceId: "space_other", botId: "bot_other", extra: 1 }),
    ).toEqual({ profile: "worker" });
  });

  it("implies the custom profile for a custom amount and validates it", () => {
    expect(parseBotPatch({ customDailyUsd: 12.345 })).toEqual({
      profile: "custom",
      customDailyUsd: 12.35,
    });
    expect(() => parseBotPatch({ customDailyUsd: 0 })).toThrow("at least $0.01");
    expect(() => parseBotPatch({ customDailyUsd: 1_000_000 })).toThrow("at most");
    expect(() => parseBotPatch({ profile: "worker", customDailyUsd: 5 })).toThrow("custom profile");
  });

  it("validates profiles, premium and limits", () => {
    expect(() => parseBotPatch({ profile: "unlimited" })).toThrow("Unknown budget profile");
    expect(() => parseBotPatch({ premium: "yes" })).toThrow("premium must be a boolean");
    expect(parseBotPatch({ maxConcurrentRuns: 3, maxSpawnDepth: null, maxSpawnFanout: 0 })).toEqual(
      { maxConcurrentRuns: 3, maxSpawnDepth: null, maxSpawnFanout: 0 },
    );
    expect(() => parseBotPatch({ maxSpawnDepth: -1 })).toThrow("whole number");
    expect(() => parseBotPatch({ maxSpawnFanout: 2.5 })).toThrow("whole number");
    expect(() => parseBotPatch({})).toThrow("Nothing to change");
  });
});

describe("raisesBudget (a bot owner who is not a space owner)", () => {
  const defaults = {
    budgetDefaultDailyUsd: 3,
    budgetSpaceDailyUsd: 50,
    maxConcurrentRunsPerBot: 2,
    maxSpawnDepth: 2,
    maxSpawnFanout: 5,
  };

  it("allows the assistant and worker profiles and limits at or below the defaults", () => {
    for (const patch of [
      { profile: "assistant" as const },
      { profile: "worker" as const },
      { maxConcurrentRuns: 2, maxSpawnDepth: 0, maxSpawnFanout: 5 },
      { maxConcurrentRuns: null },
    ]) {
      expect(raisesBudget(patch, defaults)).toBeNull();
    }
  });

  it("refuses swarm, custom amounts, premium and limits above the defaults", () => {
    for (const patch of [
      { profile: "swarm" as const },
      { profile: "custom" as const, customDailyUsd: 1 },
      { customDailyUsd: 1 },
      { premium: true },
      { premium: false },
      { maxConcurrentRuns: 3 },
      { maxSpawnDepth: 3 },
      { maxSpawnFanout: 6 },
    ]) {
      expect(raisesBudget(patch, defaults)).toMatch(/Only a space owner/);
    }
  });
});
