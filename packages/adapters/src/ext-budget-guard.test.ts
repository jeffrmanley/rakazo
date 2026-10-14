import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentConnectionTools, builtinAgentTools } from "./builtin-tools.js";
import {
  admitDelegation,
  budgetAfterModelCall,
  claimRunWithinBotLimit,
  DELEGATION_TOOLS,
  delegationLimiter,
  installBudgetPolicy,
  recordDelegatedRun,
  refuseRunOverBudget,
  skipRoutineOverBudget,
} from "./ext-budget-guard.js";

const defaults = {
  budgetDefaultDailyUsd: 3,
  budgetSpaceDailyUsd: 50,
  maxConcurrentRunsPerBot: 2,
  maxSpawnDepth: 2,
  maxSpawnFanout: 2,
};

/** Any database access fails the test: with the flag off nothing may be read or written. */
const untouchable = new Proxy(
  {},
  {
    get(_target, key) {
      throw new Error(`database touched: ${String(key)}`);
    },
  },
) as unknown as PrismaClient;

const run = {
  id: "run_1",
  spaceId: "space_1",
  botId: "bot_1",
  userId: "user_1",
  threadId: "thread_1",
  trigger: "user",
  taskId: "task_1",
};

afterEach(() => installBudgetPolicy(null));

describe("budget guard with EXT_BUDGETS off", () => {
  const jobs = { enqueue: vi.fn(), cancel: vi.fn(), close: vi.fn() };
  const events = {} as never;

  it("claims runs exactly as before", async () => {
    const claim = vi.fn(async (_db: unknown) => ({ count: 1 }));
    await expect(
      claimRunWithinBotLimit({ prisma: untouchable, jobs }, run, claim),
    ).resolves.toEqual({ count: 1 });
    expect(claim.mock.calls[0]?.[0] === untouchable).toBe(true);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it("never refuses, halts, skips or records", async () => {
    const deps = { prisma: untouchable, jobs, events };
    await expect(
      refuseRunOverBudget(deps, { run, workerId: "w", fence: 1, attemptId: "a" }),
    ).resolves.toBe(false);
    await expect(budgetAfterModelCall(deps, run)).resolves.toBe(false);
    await expect(admitDelegation(untouchable, run, "message_bot")).resolves.toBeNull();
    await expect(
      skipRoutineOverBudget(
        { prisma: untouchable, jobs },
        {
          routine: { id: "r", spaceId: "space_1", crons: [] },
          botId: "bot_1",
          scheduledAt: new Date(),
          nextRunAt: null,
        },
      ),
    ).resolves.toBe(false);
    await expect(
      recordDelegatedRun(untouchable as never, {
        spaceId: "space_1",
        parentRunId: "run_1",
        childRunId: "run_2",
        tool: "message_bot",
      }),
    ).resolves.toBeUndefined();
  });

  it("returns the tool function untouched", async () => {
    const execute = vi.fn();
    expect(delegationLimiter(untouchable, run).wrap(execute)).toBe(execute);
    await expect(delegationLimiter(untouchable, run).admit("run_subagent")).resolves.toBeNull();
  });
});

/** A small in-memory stand-in for the three tables the delegation check reads. */
function fakeSpawnDb(input: { depth: number; started: number }) {
  const spawns: Array<{ parentRunId: string; tool: string; depth: number }> = [];
  const db: Record<string, unknown> = {
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(db)),
    extBotBudget: { findFirst: vi.fn(async () => null) },
    extRunSpawn: {
      findUnique: vi.fn(async () => (input.depth ? { depth: input.depth } : null)),
      count: vi.fn(async () => input.started + spawns.length),
      createMany: vi.fn(async ({ data }: { data: typeof spawns }) => {
        spawns.push(...data);
        return { count: data.length };
      }),
    },
  };
  return { db: db as unknown as PrismaClient, spawns };
}

describe("delegation limits", () => {
  it("refuses a delegation beyond the depth limit as a tool error, without running it", async () => {
    installBudgetPolicy(defaults);
    const { db } = fakeSpawnDb({ depth: 2, started: 0 });
    const execute = vi.fn(async () => ({ ok: true }));
    const tools = delegationLimiter(db, run).wrap(execute);
    const result = (await tools("message_bot", { message: "hi" }, "e1")) as { error: string };
    expect(result.error).toMatch(/depth limit \(2\)/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("counts in-run sub-agents and refuses past the fan-out, one call at a time", async () => {
    installBudgetPolicy(defaults);
    const { db, spawns } = fakeSpawnDb({ depth: 0, started: 0 });
    const execute = vi.fn(async () => ({ ok: true }));
    const tools = delegationLimiter(db, run).wrap(execute);
    const results = (await Promise.all([
      tools("run_subagent", {}, "e1"),
      tools("run_subagent", {}, "e2"),
      tools("run_subagent", {}, "e3"),
    ])) as Array<{ ok?: boolean; error?: string }>;
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(results.filter((result) => result.error?.includes("limit is 2"))).toHaveLength(1);
    expect(spawns).toEqual([
      expect.objectContaining({ parentRunId: "run_1", tool: "run_subagent", depth: 1 }),
      expect.objectContaining({ parentRunId: "run_1", tool: "run_subagent", depth: 1 }),
    ]);
  });

  it("leaves other tools alone and refuses every tool after a budget halt", async () => {
    installBudgetPolicy(defaults);
    const { db } = fakeSpawnDb({ depth: 0, started: 0 });
    const execute = vi.fn(async () => ({ ok: true }));
    let halted = false;
    const tools = delegationLimiter(db, run, () => halted).wrap(execute);
    await expect(tools("shell", { command: "ls" }, "e1")).resolves.toEqual({ ok: true });
    halted = true;
    await expect(tools("shell", { command: "ls" }, "e2")).resolves.toEqual({
      error: "Stopped: daily budget reached.",
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("covers every tool that hands work to another run, bot or agent", () => {
    const names = new Set(builtinAgentTools.map((tool) => tool.name));
    for (const tool of DELEGATION_TOOLS) expect(names.has(tool)).toBe(true);
  });
});

describe("policy changes are human-only", () => {
  it("offers the model no tool that can change a budget, a limit or premium", () => {
    const pattern = /budget|spend|premium|top.?up|concurren|fan.?out|spawn.?depth|daily.?cap/i;
    for (const tool of [...builtinAgentTools, ...agentConnectionTools]) {
      expect(tool.name).not.toMatch(pattern);
      const properties = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      for (const property of properties) expect(property).not.toMatch(pattern);
    }
  });
});
