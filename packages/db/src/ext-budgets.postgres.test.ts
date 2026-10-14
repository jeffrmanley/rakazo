import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  addBudgetTopUp,
  admitRunSpawn,
  claimBotRunSlot,
  claimBudgetNotice,
  countRunSpawns,
  isSpaceOwner,
  loadBudgetStatus,
  monthSpendUsd,
  recordRunSpawn,
  runSpawnDepth,
  saveBotBudget,
  saveSpaceBudget,
  spaceOwnerUserId,
} from "./ext-budgets.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const defaults = {
  budgetDefaultDailyUsd: 3,
  budgetSpaceDailyUsd: 50,
  maxConcurrentRunsPerBot: 2,
  maxSpawnDepth: 2,
  maxSpawnFanout: 5,
};

describePostgres("ext budgets (PostgreSQL)", () => {
  let prisma: PrismaClient;
  /** A second client with its own pool: a second worker process. */
  let other: PrismaClient;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const first = createDb(databaseUrl!);
    const second = createDb(databaseUrl!);
    prisma = first.prisma;
    other = second.prisma;
    close = async () => {
      for (const db of [first, second]) {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    };
  });

  afterAll(async () => {
    await close?.();
  });

  async function seedSpace(label: string) {
    const id = `${label}-${randomUUID()}`;
    const org = await prisma.organization.create({
      data: { id: `org-${id}`, name: label, slug: `org-${id}`, createdAt: new Date() },
    });
    const space = await prisma.space.create({
      data: { id: `space-${id}`, organizationId: org.id, name: label },
    });
    const owner = await seedMember(space, "owner");
    const bot = await seedBot(space.id, owner);
    return { spaceId: space.id, organizationId: org.id, owner, bot, seedMember, seedBot };
  }

  async function seedMember(space: { id: string; organizationId: string }, role: string) {
    const userId = `user-${randomUUID()}`;
    await prisma.user.create({
      data: { id: userId, name: "Person", email: `${userId}@example.test` },
    });
    await prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: space.organizationId,
        userId,
        role,
        createdAt: new Date(),
      },
    });
    await prisma.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId: space.id,
        organizationId: space.organizationId,
        userId,
        role,
        createdAt: new Date(),
      },
    });
    return userId;
  }

  async function seedBot(spaceId: string, userId: string) {
    const bot = await prisma.bot.create({
      data: { spaceId, userId, name: "Budget bot", color: "#000000" },
    });
    const thread = await prisma.thread.create({ data: { spaceId, userId, botId: bot.id } });
    return { id: bot.id, threadId: thread.id, spaceId, userId };
  }

  async function seedRun(
    bot: { id: string; threadId: string; spaceId: string; userId: string },
    state: { status: string; leaseExpiresAt?: Date } = { status: "queued" },
  ) {
    const task = await prisma.task.create({
      data: {
        spaceId: bot.spaceId,
        botId: bot.id,
        threadId: bot.threadId,
        userId: bot.userId,
        prompt: "work",
        status: "queued",
      },
    });
    return prisma.run.create({
      data: {
        spaceId: bot.spaceId,
        botId: bot.id,
        threadId: bot.threadId,
        taskId: task.id,
        userId: bot.userId,
        trigger: "user",
        ...state,
      },
    });
  }

  async function spend(
    seed: { spaceId: string; owner: string },
    botId: string,
    costUsd: number,
    at: Date,
  ) {
    await prisma.usageRecord.create({
      data: {
        spaceId: seed.spaceId,
        userId: seed.owner,
        botId,
        provider: "fixture",
        model: "fixture",
        costUsd,
        createdAt: at,
      },
    });
  }

  it("sums today's priced usage by UTC day and bot, and caps with profiles and the space", async () => {
    const seed = await seedSpace("spend");
    const now = new Date("2031-05-10T12:00:00Z");
    await spend(seed, seed.bot.id, 1.25, new Date("2031-05-10T00:00:00Z"));
    await spend(seed, seed.bot.id, 0.5, new Date("2031-05-10T23:59:59.999Z"));
    // Yesterday and tomorrow (UTC) do not count.
    await spend(seed, seed.bot.id, 9, new Date("2031-05-09T23:59:59.999Z"));
    await spend(seed, seed.bot.id, 9, new Date("2031-05-11T00:00:00Z"));
    const sibling = await seedBot(seed.spaceId, seed.owner);
    await spend(seed, sibling.id, 2, now);

    const status = await loadBudgetStatus(prisma, {
      spaceId: seed.spaceId,
      botId: seed.bot.id,
      now,
      defaults,
    });
    expect(status.day).toBe("2031-05-10");
    expect(status.resetsAt.toISOString()).toBe("2031-05-11T00:00:00.000Z");
    expect(status.bot).toMatchObject({
      spentUsd: 1.75,
      capUsd: 3,
      level: "ok",
      profile: "assistant",
    });
    expect(status.space).toMatchObject({ spentUsd: 3.75, capUsd: 50, level: "ok", custom: false });

    await prisma.$transaction((tx) =>
      saveBotBudget(tx, {
        spaceId: seed.spaceId,
        botId: seed.bot.id,
        actorId: seed.owner,
        patch: { profile: "custom", customDailyUsd: 2 },
      }),
    );
    await prisma.$transaction((tx) =>
      saveSpaceBudget(tx, { spaceId: seed.spaceId, actorId: seed.owner, dailyUsd: 4 }),
    );
    const capped = await loadBudgetStatus(prisma, {
      spaceId: seed.spaceId,
      botId: seed.bot.id,
      now,
      defaults,
    });
    expect(capped.bot).toMatchObject({ capUsd: 2, level: "warn" }); // 87.5%
    expect(capped.space).toMatchObject({ capUsd: 4, level: "warn", custom: true });
    await spend(seed, seed.bot.id, 0.25, now);
    const blocked = await loadBudgetStatus(prisma, {
      spaceId: seed.spaceId,
      botId: seed.bot.id,
      now,
      defaults,
    });
    expect(blocked.bot.level).toBe("blocked");
    expect(blocked.space.level).toBe("blocked");
  });

  it("applies a top-up to today only", async () => {
    const seed = await seedSpace("topup");
    const today = new Date("2031-06-01T22:00:00Z");
    await spend(seed, seed.bot.id, 3, today);
    await prisma.$transaction((tx) =>
      addBudgetTopUp(tx, {
        spaceId: seed.spaceId,
        botId: seed.bot.id,
        amountUsd: 2,
        actorId: seed.owner,
        now: today,
      }),
    );
    const raised = await loadBudgetStatus(prisma, {
      spaceId: seed.spaceId,
      botId: seed.bot.id,
      now: today,
      defaults,
    });
    expect(raised.bot).toMatchObject({ capUsd: 5, topUpUsd: 2, level: "ok" });
    const tomorrow = await loadBudgetStatus(prisma, {
      spaceId: seed.spaceId,
      botId: seed.bot.id,
      now: new Date("2031-06-02T00:00:00Z"),
      defaults,
    });
    expect(tomorrow.bot).toMatchObject({ capUsd: 3, topUpUsd: 0 });
  });

  it("keeps spend, settings and top-ups inside their space", async () => {
    const a = await seedSpace("isolation-a");
    const b = await seedSpace("isolation-b");
    const now = new Date();
    await spend(a, a.bot.id, 40, now);
    await prisma.$transaction((tx) =>
      addBudgetTopUp(tx, { spaceId: a.spaceId, botId: null, amountUsd: 10, actorId: a.owner, now }),
    );
    const fromB = await loadBudgetStatus(prisma, {
      spaceId: b.spaceId,
      botId: b.bot.id,
      now,
      defaults,
    });
    expect(fromB.space).toMatchObject({ spentUsd: 0, topUpUsd: 0, capUsd: 50 });
    // Asking for A's bot under B's space finds no spend and no settings.
    const crossed = await loadBudgetStatus(prisma, {
      spaceId: b.spaceId,
      botId: a.bot.id,
      now,
      defaults,
    });
    expect(crossed.bot.spentUsd).toBe(0);
    expect(await monthSpendUsd(prisma, { spaceId: b.spaceId, now })).toBe(0);
  });

  it("sends a notice once per period across concurrent workers", async () => {
    const seed = await seedSpace("notice");
    const key = { spaceId: seed.spaceId, kind: "bot.warn" as const, subjectId: seed.bot.id };
    const claims = await Promise.all([
      ...Array.from({ length: 4 }, () =>
        claimBudgetNotice(prisma, { ...key, period: "2031-07-01" }),
      ),
      ...Array.from({ length: 4 }, () =>
        claimBudgetNotice(other, { ...key, period: "2031-07-01" }),
      ),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await claimBudgetNotice(prisma, { ...key, period: "2031-07-02" })).toBe(true);
  });

  it("lets only maxConcurrentRuns claimers through across two clients, then frees a slot", async () => {
    const seed = await seedSpace("slots");
    const runs = await Promise.all([seedRun(seed.bot), seedRun(seed.bot), seedRun(seed.bot)]);
    // The pause widens the window between counting and claiming, where a race would land.
    const lease = (runId: string) => async (tx: Pick<PrismaClient, "run">) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return tx.run.updateMany({
        where: { id: runId, status: "queued" },
        data: { status: "leased", leaseOwner: "w", leaseExpiresAt: new Date(Date.now() + 60_000) },
      });
    };
    const results = await Promise.all(
      runs.map((run, index) =>
        claimBotRunSlot(
          index % 2 === 0 ? prisma : other,
          { botId: seed.bot.id, runId: run.id, maxConcurrentRuns: 2 },
          lease(run.id),
        ),
      ),
    );
    expect(results.filter((result) => !result.queued)).toHaveLength(2);
    const queuedIndex = results.findIndex((result) => result.queued);
    expect(queuedIndex).toBeGreaterThanOrEqual(0);
    const waiting = runs[queuedIndex]!;
    expect((await prisma.run.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe(
      "queued",
    );

    // An expired lease (a dead worker) does not hold a slot, and a finished run frees one.
    const finished = runs.find((_, index) => index !== queuedIndex)!;
    await prisma.run.update({ where: { id: finished.id }, data: { status: "completed" } });
    const retried = await claimBotRunSlot(
      other,
      { botId: seed.bot.id, runId: waiting.id, maxConcurrentRuns: 2 },
      lease(waiting.id),
    );
    expect(retried).toMatchObject({ queued: false, result: { count: 1 } });
  });

  it("does not count an expired lease against the cap", async () => {
    const seed = await seedSpace("expired");
    await seedRun(seed.bot, { status: "running", leaseExpiresAt: new Date(Date.now() - 1_000) });
    const fresh = await seedRun(seed.bot);
    const result = await claimBotRunSlot(
      prisma,
      { botId: seed.bot.id, runId: fresh.id, maxConcurrentRuns: 1 },
      async () => "claimed",
    );
    expect(result).toEqual({ queued: false, result: "claimed" });
  });

  it("admits exactly the fan-out when ten delegations race on one run across two clients", async () => {
    const seed = await seedSpace("fanout-race");
    const parent = await seedRun(seed.bot);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        admitRunSpawn(index % 2 === 0 ? prisma : other, {
          spaceId: seed.spaceId,
          parentRunId: parent.id,
          tool: "run_subagent",
          limits: { maxSpawnDepth: 2, maxSpawnFanout: 5 },
          record: true,
        }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(5);
    expect(results.filter((result) => !result.ok)).toHaveLength(5);
    expect(await countRunSpawns(prisma, parent.id)).toBe(5);
  });

  it("checks without counting when the delegation records its own run", async () => {
    const seed = await seedSpace("fanout-check");
    const parent = await seedRun(seed.bot);
    const admitted = await admitRunSpawn(prisma, {
      spaceId: seed.spaceId,
      parentRunId: parent.id,
      tool: "message_bot",
      limits: { maxSpawnDepth: 2, maxSpawnFanout: 5 },
      record: false,
    });
    expect(admitted).toEqual({ ok: true, depth: 1 });
    expect(await countRunSpawns(prisma, parent.id)).toBe(0);
  });

  it("tracks delegation depth along the parent chain and fan-out per run", async () => {
    const seed = await seedSpace("lineage");
    const [root, child, grandchild] = await Promise.all([
      seedRun(seed.bot),
      seedRun(seed.bot),
      seedRun(seed.bot),
    ]);
    expect(await runSpawnDepth(prisma, root.id)).toBe(0);
    await recordRunSpawn(prisma, {
      spaceId: seed.spaceId,
      parentRunId: root.id,
      childRunId: child.id,
      tool: "message_bot",
      depth: 1,
    });
    await recordRunSpawn(prisma, {
      spaceId: seed.spaceId,
      parentRunId: child.id,
      childRunId: grandchild.id,
      tool: "spawn_bot",
      depth: 2,
    });
    await recordRunSpawn(prisma, {
      spaceId: seed.spaceId,
      parentRunId: root.id,
      childRunId: null,
      tool: "run_subagent",
      depth: 1,
    });
    expect(await runSpawnDepth(prisma, grandchild.id)).toBe(2);
    expect(await countRunSpawns(prisma, root.id)).toBe(2);
    expect(await countRunSpawns(prisma, grandchild.id)).toBe(0);
  });

  it("finds the space owner and refuses ownership to plain members", async () => {
    const seed = await seedSpace("owner");
    const member = await seedMember(
      { id: seed.spaceId, organizationId: seed.organizationId },
      "member",
    );
    expect(await spaceOwnerUserId(prisma, seed.spaceId)).toBe(seed.owner);
    expect(await isSpaceOwner(prisma, { spaceId: seed.spaceId, userId: seed.owner })).toBe(true);
    expect(await isSpaceOwner(prisma, { spaceId: seed.spaceId, userId: member })).toBe(false);
  });
});
