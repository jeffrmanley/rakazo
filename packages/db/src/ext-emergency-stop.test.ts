import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveStop } from "./ext-emergency-stop.js";
import {
  createEmergencyStopReader,
  getEmergencyStop,
  installEmergencyStop,
  resolveStop,
  stopLockKey,
} from "./ext-emergency-stop.js";

const at = new Date("2026-10-15T10:00:00Z");

function stop(overrides: Partial<ActiveStop>): ActiveStop {
  return {
    id: "stop-1",
    scope: "bot",
    spaceId: "space-a",
    botId: "bot-1",
    reason: "test",
    stoppedBy: "user-1",
    stoppedAt: at,
    ...overrides,
  };
}

describe("resolveStop", () => {
  const botStop = stop({ id: "b", scope: "bot", botId: "bot-1" });
  const spaceStop = stop({ id: "s", scope: "space", botId: null });
  const globalStop = stop({ id: "g", scope: "global", spaceId: null, botId: null });

  it("halts only the stopped bot", () => {
    expect(resolveStop([botStop], { spaceId: "space-a", botId: "bot-1" })).toBe(botStop);
    expect(resolveStop([botStop], { spaceId: "space-a", botId: "bot-2" })).toBeNull();
    // A space-level question ignores bot stops.
    expect(resolveStop([botStop], { spaceId: "space-a" })).toBeNull();
  });

  it("halts every bot of a stopped space and nothing in another space", () => {
    expect(resolveStop([spaceStop], { spaceId: "space-a", botId: "bot-9" })).toBe(spaceStop);
    expect(resolveStop([spaceStop], { spaceId: "space-a" })).toBe(spaceStop);
    expect(resolveStop([spaceStop], { spaceId: "space-b", botId: "bot-9" })).toBeNull();
    // A bot stop recorded for another space never matches by bot id alone.
    expect(
      resolveStop([stop({ spaceId: "space-b", botId: "bot-1" })], {
        spaceId: "space-a",
        botId: "bot-1",
      }),
    ).toBeNull();
  });

  it("halts everything under a global stop and reports the broadest stop first", () => {
    expect(resolveStop([globalStop], { spaceId: "space-z", botId: "bot-z" })).toBe(globalStop);
    expect(
      resolveStop([botStop, spaceStop, globalStop], { spaceId: "space-a", botId: "bot-1" }),
    ).toBe(globalStop);
    expect(resolveStop([botStop, spaceStop], { spaceId: "space-a", botId: "bot-1" })).toBe(
      spaceStop,
    );
  });

  it("is running when nothing is stopped (all stops resumed)", () => {
    expect(resolveStop([], { spaceId: "space-a", botId: "bot-1" })).toBeNull();
  });
});

describe("createEmergencyStopReader", () => {
  function fakePrisma(rows: () => ActiveStop[]) {
    const findMany = vi.fn(async (args: { where: unknown }) => {
      void args;
      return rows();
    });
    return { prisma: { extControlStop: { findMany } }, findMany };
  }

  it("asks the database for global stops and the space's own active stops only", async () => {
    const { prisma, findMany } = fakePrisma(() => []);
    const reader = createEmergencyStopReader(prisma as never);
    await reader.check({ spaceId: "space-a", botId: "bot-1" });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { resumedAt: null, OR: [{ scope: "global" }, { spaceId: "space-a" }] },
      }),
    );
  });

  it("caches per space for the TTL, then rereads", async () => {
    let now = 0;
    let rows: ActiveStop[] = [];
    const { prisma, findMany } = fakePrisma(() => rows);
    const reader = createEmergencyStopReader(prisma as never, { ttlMs: 1_000, now: () => now });
    expect(await reader.check({ spaceId: "space-a", botId: "bot-1" })).toBeNull();
    rows = [stop({})];
    now = 999;
    expect(await reader.check({ spaceId: "space-a", botId: "bot-1" })).toBeNull();
    expect(findMany).toHaveBeenCalledTimes(1);
    // Another space is a separate cache entry.
    await reader.check({ spaceId: "space-b" });
    expect(findMany).toHaveBeenCalledTimes(2);
    now = 1_000;
    expect(await reader.check({ spaceId: "space-a", botId: "bot-1" })).toMatchObject({
      id: "stop-1",
    });
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it("drops the cache on invalidate so this process sees its own change at once", async () => {
    let rows: ActiveStop[] = [];
    const { prisma } = fakePrisma(() => rows);
    const reader = createEmergencyStopReader(prisma as never, { ttlMs: 60_000 });
    expect(await reader.check({ spaceId: "space-a", botId: "bot-1" })).toBeNull();
    rows = [stop({})];
    reader.invalidate();
    expect(await reader.check({ spaceId: "space-a", botId: "bot-1" })).not.toBeNull();
  });

  it("shares one read between concurrent checks", async () => {
    const { prisma, findMany } = fakePrisma(() => []);
    const reader = createEmergencyStopReader(prisma as never);
    await Promise.all([
      reader.check({ spaceId: "space-a", botId: "bot-1" }),
      reader.check({ spaceId: "space-a", botId: "bot-2" }),
      reader.activeStops("space-a"),
    ]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("propagates a read failure instead of reporting the bot as running", async () => {
    const prisma = {
      extControlStop: { findMany: vi.fn(async () => Promise.reject(new Error("db down"))) },
    };
    const reader = createEmergencyStopReader(prisma as never);
    await expect(reader.check({ spaceId: "space-a", botId: "bot-1" })).rejects.toThrow("db down");
  });
});

describe("installed reader", () => {
  afterEach(() => installEmergencyStop(null));

  it("is absent until a composition root installs one (flag off)", () => {
    expect(getEmergencyStop()).toBeNull();
    const reader = createEmergencyStopReader({ extControlStop: { findMany: vi.fn() } } as never);
    installEmergencyStop(reader);
    expect(getEmergencyStop()).toBe(reader);
  });
});

describe("stopLockKey", () => {
  it("serializes writers per target", () => {
    expect(stopLockKey({ scope: "global", spaceId: null, botId: null })).toBe("ext_control:global");
    expect(stopLockKey({ scope: "space", spaceId: "s", botId: null })).toBe("ext_control:space:s");
    expect(stopLockKey({ scope: "bot", spaceId: "s", botId: "b" })).toBe("ext_control:bot:s:b");
  });
});
