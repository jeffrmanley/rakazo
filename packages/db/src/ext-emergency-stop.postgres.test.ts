import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  cancelRunsForStop,
  createEmergencyStopReader,
  recordResume,
  recordStop,
} from "./ext-emergency-stop.js";
import { provisionMessagingIdentity } from "./messaging.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("ext emergency stop (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const opened: Array<() => Promise<void>> = [];
  let prisma: PrismaClient;
  let owner: { userId: string; spaceId: string; botId: string; threadId: string };
  let other: { userId: string; spaceId: string; botId: string; threadId: string };

  const open = () => {
    const db = createDb(databaseUrl!);
    opened.push(async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    });
    return db.prisma;
  };

  const provision = async (name: string) => {
    const ids = await provisionMessagingIdentity(
      prisma,
      { provider: "ext-stop-test", address: `${name}-${suffix}` },
      { signupsEnabled: "true", signupAllowlist: "" },
    );
    return { userId: ids.userId, spaceId: ids.spaceId, botId: ids.botId, threadId: ids.threadId };
  };

  const queueRun = async (
    target: { userId: string; spaceId: string; botId: string; threadId: string },
    status: string,
  ) => {
    const task = await prisma.task.create({
      data: {
        spaceId: target.spaceId,
        botId: target.botId,
        threadId: target.threadId,
        userId: target.userId,
        prompt: "test",
        status: "queued",
      },
    });
    return prisma.run.create({
      data: {
        spaceId: target.spaceId,
        botId: target.botId,
        threadId: target.threadId,
        taskId: task.id,
        userId: target.userId,
        status,
        trigger: "user",
      },
    });
  };

  beforeAll(async () => {
    prisma = open();
    owner = await provision("owner");
    other = await provision("other");
  });

  afterAll(async () => {
    await prisma.extControlStop.updateMany({
      where: { spaceId: { in: [owner?.spaceId, other?.spaceId].filter(Boolean) }, resumedAt: null },
      data: { resumedAt: new Date(), resumedBy: "test-cleanup" },
    });
    for (const close of opened.reverse()) await close();
  });

  it("persists a stop across a restart until it is resumed, and keeps the history", async () => {
    const { stop, created } = await recordStop(prisma, {
      scope: "bot",
      spaceId: owner.spaceId,
      botId: owner.botId,
      reason: "runaway loop",
      userId: owner.userId,
    });
    expect(created).toBe(true);
    // A second stop of the same target is the same stop.
    const again = await recordStop(prisma, {
      scope: "bot",
      spaceId: owner.spaceId,
      botId: owner.botId,
      reason: "again",
      userId: owner.userId,
    });
    expect(again).toEqual({ stop, created: false });

    // A "restarted" process: a new client and a new reader see the stop.
    const restarted = open();
    const reader = createEmergencyStopReader(restarted);
    await expect(reader.check({ spaceId: owner.spaceId, botId: owner.botId })).resolves.toEqual(
      stop,
    );
    await expect(reader.check({ spaceId: owner.spaceId, botId: "another-bot" })).resolves.toBe(
      null,
    );
    // Another space neither sees nor is affected by this space's stop.
    await expect(reader.check({ spaceId: other.spaceId, botId: other.botId })).resolves.toBe(null);
    await expect(reader.activeStops(other.spaceId)).resolves.toEqual([]);

    // A space resume does not lift a bot stop; the bot resume does.
    await expect(
      recordResume(prisma, {
        scope: "space",
        spaceId: owner.spaceId,
        botId: null,
        userId: owner.userId,
      }),
    ).resolves.toEqual([]);
    const resumed = await recordResume(prisma, {
      scope: "bot",
      spaceId: owner.spaceId,
      botId: owner.botId,
      userId: owner.userId,
    });
    expect(resumed.map((row) => row.id)).toEqual([stop.id]);
    reader.invalidate();
    await expect(reader.check({ spaceId: owner.spaceId, botId: owner.botId })).resolves.toBe(null);
    const history = await prisma.extControlStop.findUniqueOrThrow({ where: { id: stop.id } });
    expect(history).toMatchObject({ resumedBy: owner.userId, reason: "runaway loop" });
    expect(history.resumedAt).toBeInstanceOf(Date);
  });

  it("rolls a resume back when the in-transaction hook (the audit insert) fails", async () => {
    const { stop } = await recordStop(prisma, {
      scope: "space",
      spaceId: owner.spaceId,
      botId: null,
      reason: "maintenance",
      userId: owner.userId,
    });
    await expect(
      recordResume(
        prisma,
        { scope: "space", spaceId: owner.spaceId, botId: null, userId: owner.userId },
        async () => {
          throw new Error("audit down");
        },
      ),
    ).rejects.toThrow("audit down");
    const row = await prisma.extControlStop.findUniqueOrThrow({ where: { id: stop.id } });
    expect(row.resumedAt).toBeNull();
    await recordResume(prisma, {
      scope: "space",
      spaceId: owner.spaceId,
      botId: null,
      userId: owner.userId,
    });
  });

  it("enforces the scope shape in the database", async () => {
    await expect(
      prisma.extControlStop.create({
        data: {
          id: `bad-${suffix}`,
          scope: "global",
          spaceId: owner.spaceId,
          botId: null,
          reason: "x",
          stoppedBy: owner.userId,
          stoppedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it("cancels the scope's runs with one run.cancelled event each, leaving other spaces alone", async () => {
    const queued = await queueRun(owner, "queued");
    const waiting = await queueRun(owner, "waiting_input");
    const running = await queueRun(owner, "running");
    const foreign = await queueRun(other, "queued");
    const cancelled = await cancelRunsForStop(prisma, {
      spaceId: owner.spaceId,
      statuses: ["queued", "leased", "waiting_input", "waiting_takeover"],
    });
    expect(new Set(cancelled.runIds)).toEqual(new Set([queued.id, waiting.id]));
    expect(cancelled.threads).toEqual([{ threadId: owner.threadId, seq: expect.any(Number) }]);
    const statuses = await prisma.run.findMany({
      where: { id: { in: [queued.id, waiting.id, running.id, foreign.id] } },
      select: { id: true, status: true, completedAt: true },
    });
    const byId = new Map(statuses.map((row) => [row.id, row]));
    expect(byId.get(queued.id)?.status).toBe("cancelled");
    expect(byId.get(waiting.id)?.status).toBe("cancelled");
    expect(byId.get(running.id)?.status).toBe("running");
    expect(byId.get(foreign.id)?.status).toBe("queued");
    const events = await prisma.event.findMany({
      where: { type: "run.cancelled", runId: { in: [queued.id, waiting.id] } },
    });
    expect(events).toHaveLength(2);
    await expect(
      prisma.task.count({
        where: { id: { in: [queued.taskId, waiting.taskId] }, status: "cancelled" },
      }),
    ).resolves.toBe(2);
    // The running run is the worker's to halt; clean up the rest.
    await cancelRunsForStop(prisma, {
      runIds: [running.id, foreign.id],
      statuses: ["queued", "running"],
    });
  });

  it("cancels a large scope in batches, so no single transaction outlives its timeout", async () => {
    const big = await provision("big");
    const count = 250;
    const tasks = Array.from({ length: count }, (_, index) => ({
      id: `stop-batch-task-${suffix}-${index}`,
      spaceId: big.spaceId,
      botId: big.botId,
      threadId: big.threadId,
      userId: big.userId,
      prompt: "batch",
      status: "queued",
    }));
    await prisma.task.createMany({ data: tasks });
    await prisma.run.createMany({
      data: tasks.map((task, index) => ({
        id: `stop-batch-run-${suffix}-${index}`,
        spaceId: big.spaceId,
        botId: big.botId,
        threadId: big.threadId,
        taskId: task.id,
        userId: big.userId,
        status: "queued",
        trigger: "user",
      })),
    });
    const transactions: Array<{ timeout?: number }> = [];
    const spy = new Proxy(prisma, {
      get(target, key, receiver) {
        if (key === "$transaction") {
          return (fn: unknown, options?: { timeout?: number }) => {
            transactions.push(options ?? {});
            return (target.$transaction as (...args: unknown[]) => unknown)(fn, options);
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const cancelled = await cancelRunsForStop(spy, {
      spaceId: big.spaceId,
      statuses: ["queued"],
    });
    expect(cancelled.runIds).toHaveLength(count);
    expect(cancelled.threads).toEqual([{ threadId: big.threadId, seq: expect.any(Number) }]);
    await expect(
      prisma.run.count({ where: { spaceId: big.spaceId, status: "cancelled" } }),
    ).resolves.toBe(count);
    await expect(
      prisma.event.count({ where: { threadId: big.threadId, type: "run.cancelled" } }),
    ).resolves.toBe(count);
    // Three batches of at most 100 runs, each with an explicit timeout.
    expect(transactions).toHaveLength(3);
    for (const options of transactions) expect(options.timeout).toBeGreaterThan(5_000);
  });

  it("commits the paused notice with the cancellation, and only for runs it cancels", async () => {
    const queued = await queueRun(owner, "queued");
    const done = await queueRun(owner, "completed");
    const cancelled = await cancelRunsForStop(
      prisma,
      { runIds: [queued.id, done.id], statuses: ["queued", "running"] },
      new Date(),
      { notice: "Paused by Dana at 2026-10-16 01:00 UTC" },
    );
    expect(cancelled.runIds).toEqual([queued.id]);
    const notices = await prisma.message.findMany({
      where: {
        clientNonce: { in: [`ext-stop-paused:${queued.id}`, `ext-stop-paused:${done.id}`] },
      },
    });
    expect(notices).toEqual([
      expect.objectContaining({
        role: "system",
        threadId: owner.threadId,
        clientNonce: `ext-stop-paused:${queued.id}`,
        blocks: [{ kind: "meta", text: "Paused by Dana at 2026-10-16 01:00 UTC" }],
      }),
    ]);
    // The note's event precedes the run's cancellation event in the same commit.
    const events = await prisma.event.findMany({
      where: { threadId: owner.threadId, seq: { lte: cancelled.threads[0]!.seq } },
      orderBy: { seq: "desc" },
      take: 2,
      select: { type: true, runId: true },
    });
    expect(events).toEqual([
      { type: "run.cancelled", runId: queued.id },
      { type: "thread.message.created", runId: null },
    ]);
  });
});
