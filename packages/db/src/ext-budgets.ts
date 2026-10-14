/**
 * Fork extension: storage and queries for spend caps, run concurrency and delegation
 * limits (EXT_BUDGETS). Rules live in `@rakazo/core` (ext-budget.ts). Every read and
 * write is scoped by a spaceId the caller took from the authenticated session or the
 * run row, never from request input.
 */
import { randomUUID } from "node:crypto";
import type {
  BotBudgetSettings,
  BotLimitSettings,
  BudgetDefaults,
  BudgetLevel,
  BudgetNoticeKind,
  BudgetProfile,
} from "@rakazo/core";
import { budgetLevel, dailyCapUsd, isBudgetProfile, utcDay, utcMonth } from "@rakazo/core";
import type { Prisma, PrismaClient } from "./client.js";

type Db = PrismaClient | Prisma.TransactionClient;

export interface BotBudgetRecord extends BotBudgetSettings, BotLimitSettings {
  premium: boolean;
}

export const DEFAULT_BOT_BUDGET: BotBudgetRecord = {
  profile: "assistant",
  customDailyUsd: null,
  premium: false,
  maxConcurrentRuns: null,
  maxSpawnDepth: null,
  maxSpawnFanout: null,
};

export async function loadBotBudget(
  db: Db,
  scope: { spaceId: string; botId: string },
): Promise<BotBudgetRecord> {
  const row = await db.extBotBudget.findFirst({
    where: { botId: scope.botId, spaceId: scope.spaceId },
  });
  if (!row) return { ...DEFAULT_BOT_BUDGET };
  return {
    profile: isBudgetProfile(row.profile) ? row.profile : "assistant",
    customDailyUsd: row.customDailyUsd,
    premium: row.premium,
    maxConcurrentRuns: row.maxConcurrentRuns,
    maxSpawnDepth: row.maxSpawnDepth,
    maxSpawnFanout: row.maxSpawnFanout,
  };
}

export type BotBudgetPatch = Partial<BotBudgetRecord>;

export async function saveBotBudget(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; botId: string; actorId: string; patch: BotBudgetPatch },
): Promise<BotBudgetRecord> {
  const current = await loadBotBudget(tx, input);
  const next: BotBudgetRecord = { ...current, ...input.patch };
  // A fixed profile carries no custom amount; switching back keeps the record unambiguous.
  if (next.profile !== "custom") next.customDailyUsd = null;
  await tx.extBotBudget.upsert({
    where: { botId: input.botId },
    create: {
      botId: input.botId,
      spaceId: input.spaceId,
      ...next,
      createdBy: input.actorId,
      updatedBy: input.actorId,
    },
    update: { ...next, updatedBy: input.actorId },
  });
  return next;
}

export async function loadSpaceBudgetUsd(
  db: Db,
  spaceId: string,
  defaults: Pick<BudgetDefaults, "budgetSpaceDailyUsd">,
): Promise<{ dailyUsd: number; custom: boolean }> {
  const row = await db.extSpaceBudget.findUnique({ where: { spaceId } });
  return row?.dailyUsd == null
    ? { dailyUsd: defaults.budgetSpaceDailyUsd, custom: false }
    : { dailyUsd: row.dailyUsd, custom: true };
}

export async function saveSpaceBudget(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; actorId: string; dailyUsd: number | null },
): Promise<void> {
  await tx.extSpaceBudget.upsert({
    where: { spaceId: input.spaceId },
    create: {
      spaceId: input.spaceId,
      dailyUsd: input.dailyUsd,
      createdBy: input.actorId,
      updatedBy: input.actorId,
    },
    update: { dailyUsd: input.dailyUsd, updatedBy: input.actorId },
  });
}

/** Raises today's cap for one bot (botId) or the space (botId null) until the UTC day ends. */
export async function addBudgetTopUp(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; botId: string | null; amountUsd: number; actorId: string; now: Date },
): Promise<{ id: string; day: string; expiresAt: Date }> {
  const day = utcDay(input.now);
  const row = await tx.extBudgetTopUp.create({
    data: {
      id: randomUUID(),
      spaceId: input.spaceId,
      botId: input.botId,
      day: day.key,
      amountUsd: input.amountUsd,
      createdBy: input.actorId,
    },
    select: { id: true },
  });
  return { id: row.id, day: day.key, expiresAt: day.end };
}

async function topUpUsd(
  db: Db,
  input: { spaceId: string; botId: string | null; day: string },
): Promise<number> {
  const sum = await db.extBudgetTopUp.aggregate({
    where: { spaceId: input.spaceId, botId: input.botId, day: input.day },
    _sum: { amountUsd: true },
  });
  return sum._sum.amountUsd ?? 0;
}

/** Sum of priced usage in [from, to) for the space, or one bot in it. Unpriced rows count as 0. */
export async function spendUsd(
  db: Db,
  input: { spaceId: string; botId?: string; from: Date; to: Date },
): Promise<number> {
  const sum = await db.usageRecord.aggregate({
    where: {
      spaceId: input.spaceId,
      ...(input.botId ? { botId: input.botId } : {}),
      createdAt: { gte: input.from, lt: input.to },
    },
    _sum: { costUsd: true },
  });
  return sum._sum.costUsd ?? 0;
}

export interface CapStatus {
  spentUsd: number;
  capUsd: number;
  topUpUsd: number;
  level: BudgetLevel;
}

export interface BudgetStatus {
  day: string;
  /** End of the budget day (UTC midnight): when today's top-ups expire. */
  resetsAt: Date;
  bot: CapStatus & { profile: BudgetProfile; customDailyUsd: number | null };
  space: CapStatus & { baseUsd: number; custom: boolean };
  settings: BotBudgetRecord;
}

/** Today's spend against today's caps for one bot and its space. */
export async function loadBudgetStatus(
  db: Db,
  input: { spaceId: string; botId: string; now: Date; defaults: BudgetDefaults },
): Promise<BudgetStatus> {
  const day = utcDay(input.now);
  const range = { from: day.start, to: day.end };
  const [settings, space, botSpent, spaceSpent, botTopUp, spaceTopUp] = await Promise.all([
    loadBotBudget(db, input),
    loadSpaceBudgetUsd(db, input.spaceId, input.defaults),
    spendUsd(db, { spaceId: input.spaceId, botId: input.botId, ...range }),
    spendUsd(db, { spaceId: input.spaceId, ...range }),
    topUpUsd(db, { spaceId: input.spaceId, botId: input.botId, day: day.key }),
    topUpUsd(db, { spaceId: input.spaceId, botId: null, day: day.key }),
  ]);
  const botCap = dailyCapUsd(settings, input.defaults, botTopUp);
  const spaceCap = space.dailyUsd + spaceTopUp;
  return {
    day: day.key,
    resetsAt: day.end,
    bot: {
      profile: settings.profile,
      customDailyUsd: settings.customDailyUsd,
      spentUsd: botSpent,
      capUsd: botCap,
      topUpUsd: botTopUp,
      level: budgetLevel(botSpent, botCap),
    },
    space: {
      baseUsd: space.dailyUsd,
      custom: space.custom,
      spentUsd: spaceSpent,
      capUsd: spaceCap,
      topUpUsd: spaceTopUp,
      level: budgetLevel(spaceSpent, spaceCap),
    },
    settings,
  };
}

/** Today's space-level spend and cap, without a bot. */
export async function loadSpaceBudgetStatus(
  db: Db,
  input: { spaceId: string; now: Date; defaults: BudgetDefaults },
): Promise<BudgetStatus["space"] & { day: string; resetsAt: Date }> {
  const day = utcDay(input.now);
  const [space, spent, topUp] = await Promise.all([
    loadSpaceBudgetUsd(db, input.spaceId, input.defaults),
    spendUsd(db, { spaceId: input.spaceId, from: day.start, to: day.end }),
    topUpUsd(db, { spaceId: input.spaceId, botId: null, day: day.key }),
  ]);
  const capUsd = space.dailyUsd + topUp;
  return {
    day: day.key,
    resetsAt: day.end,
    baseUsd: space.dailyUsd,
    custom: space.custom,
    spentUsd: spent,
    capUsd,
    topUpUsd: topUp,
    level: budgetLevel(spent, capUsd),
  };
}

export async function monthSpendUsd(db: Db, input: { spaceId: string; now: Date }) {
  const month = utcMonth(input.now);
  return spendUsd(db, { spaceId: input.spaceId, from: month.start, to: month.end });
}

/**
 * Claims a notice for its period. True only for the one caller that inserted it, so
 * concurrent workers crossing the same threshold send it once.
 */
export async function claimBudgetNotice(
  db: Db,
  input: { spaceId: string; kind: BudgetNoticeKind; subjectId: string; period: string },
): Promise<boolean> {
  const created = await db.extBudgetNotice.createMany({
    data: [{ id: randomUUID(), ...input }],
    skipDuplicates: true,
  });
  return created.count === 1;
}

/** Releases a claimed notice that could not be delivered, so a later crossing retries it. */
export async function releaseBudgetNotice(
  db: Db,
  input: { kind: BudgetNoticeKind; subjectId: string; period: string },
): Promise<void> {
  await db.extBudgetNotice.deleteMany({ where: input });
}

/** Distance of a run from the run a person started (0 when nothing delegated it). */
export async function runSpawnDepth(db: Db, runId: string): Promise<number> {
  const row = await db.extRunSpawn.findUnique({
    where: { childRunId: runId },
    select: { depth: true },
  });
  return row?.depth ?? 0;
}

export function countRunSpawns(db: Db, parentRunId: string): Promise<number> {
  return db.extRunSpawn.count({ where: { parentRunId } });
}

export async function recordRunSpawn(
  db: Db,
  input: {
    spaceId: string;
    parentRunId: string;
    childRunId: string | null;
    tool: string;
    depth: number;
  },
): Promise<void> {
  await db.extRunSpawn.createMany({ data: [{ id: randomUUID(), ...input }], skipDuplicates: true });
}

/** Run states that hold one of a bot's concurrency slots. */
export const RUN_SLOT_STATUSES = ["leased", "running"] as const;

/**
 * Runs `claim` only if the bot has a free run slot. A per-bot transaction-scoped
 * advisory lock serializes every claimer of the bot across processes, and the count
 * and the claim commit together, so two workers cannot both take the last slot.
 * Runs whose lease expired (a dead worker) do not hold a slot.
 */
export async function claimBotRunSlot<T>(
  prisma: PrismaClient,
  input: { botId: string; runId: string; maxConcurrentRuns: number; now?: Date },
  claim: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<{ queued: true } | { queued: false; result: T }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ext-bot-runs:${input.botId}`}, 0))`;
    const active = await tx.run.count({
      where: {
        botId: input.botId,
        id: { not: input.runId },
        status: { in: [...RUN_SLOT_STATUSES] },
        leaseExpiresAt: { gt: input.now ?? new Date() },
      },
    });
    if (active >= input.maxConcurrentRuns) return { queued: true as const };
    return { queued: false as const, result: await claim(tx) };
  });
}

/** The space's owner: the earliest member whose role includes "owner". */
export async function spaceOwnerUserId(db: Db, spaceId: string): Promise<string | null> {
  const owners = await db.spaceMember.findMany({
    where: { spaceId, role: { contains: "owner" } },
    orderBy: { createdAt: "asc" },
    select: { userId: true, role: true },
  });
  return owners.find((member) => isOwnerRole(member.role))?.userId ?? null;
}

export async function isSpaceOwner(
  db: Db,
  input: { spaceId: string; userId: string },
): Promise<boolean> {
  const member = await db.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId: input.spaceId, userId: input.userId } },
    select: { role: true },
  });
  return member ? isOwnerRole(member.role) : false;
}

function isOwnerRole(role: string): boolean {
  return role
    .split(",")
    .map((value) => value.trim())
    .includes("owner");
}
