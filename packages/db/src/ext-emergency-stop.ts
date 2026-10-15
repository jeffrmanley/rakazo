import { randomUUID } from "node:crypto";
import type { MessageBlock } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { withTransactionRetry } from "./transaction-retry.js";

/**
 * Fork extension: emergency stop (EXT_EMERGENCY_STOP).
 *
 * Stop state lives in `ext_control_stops`: a row with `resumedAt` null is an
 * active stop of one bot, one space, or the whole deployment. Rows are never
 * deleted; a resume stamps `resumedAt` and `resumedBy`. Every process reads
 * the state through a short-TTL cache keyed by space, so a stop written by the
 * API reaches the worker within the TTL plus one watcher tick.
 */

export const CONTROL_SCOPES = ["bot", "space", "global"] as const;
export type ControlScope = (typeof CONTROL_SCOPES)[number];

/** Default cache lifetime: well under the 5 second propagation budget. */
export const EMERGENCY_STOP_CACHE_TTL_MS = 1_000;

export interface StopTarget {
  scope: ControlScope;
  /** Null only for a global stop. */
  spaceId: string | null;
  /** Set only for a bot stop. */
  botId: string | null;
}

export interface ActiveStop extends StopTarget {
  id: string;
  reason: string;
  /** User id of the human who stopped it. */
  stoppedBy: string;
  stoppedAt: Date;
}

const SCOPE_RANK: Record<ControlScope, number> = { global: 0, space: 1, bot: 2 };

/**
 * The active stop that halts this bot (or, without a bot, this space), or
 * null when it may run. The broadest stop is reported first, since it is the
 * one that has to be resumed before anything runs again.
 */
export function resolveStop(
  stops: readonly ActiveStop[],
  target: { spaceId: string; botId?: string | null },
): ActiveStop | null {
  let found: ActiveStop | null = null;
  for (const stop of stops) {
    const applies =
      stop.scope === "global" ||
      (stop.scope === "space" && stop.spaceId === target.spaceId) ||
      (stop.scope === "bot" &&
        Boolean(target.botId) &&
        stop.spaceId === target.spaceId &&
        stop.botId === target.botId);
    if (!applies) continue;
    if (!found || SCOPE_RANK[stop.scope] < SCOPE_RANK[found.scope]) found = stop;
  }
  return found;
}

export interface EmergencyStopReader {
  /** The active stop halting this bot (or space when no bot is given), or null. */
  check(target: { spaceId: string; botId?: string | null }): Promise<ActiveStop | null>;
  /** Active stops visible from a space: the global ones and the space's own. */
  activeStops(spaceId: string): Promise<ActiveStop[]>;
  /** Forget cached state (one space, or everything) after this process changed it. */
  invalidate(spaceId?: string): void;
}

type StopRow = {
  id: string;
  scope: string;
  spaceId: string | null;
  botId: string | null;
  reason: string;
  stoppedBy: string;
  stoppedAt: Date;
};

function toActiveStop(row: StopRow): ActiveStop {
  return {
    id: row.id,
    scope: row.scope as ControlScope,
    spaceId: row.spaceId,
    botId: row.botId,
    reason: row.reason,
    stoppedBy: row.stoppedBy,
    stoppedAt: row.stoppedAt,
  };
}

const STOP_SELECT = {
  id: true,
  scope: true,
  spaceId: true,
  botId: true,
  reason: true,
  stoppedBy: true,
  stoppedAt: true,
} as const;

const MAX_CACHED_SPACES = 1_000;

/**
 * Reads active stops with a per-space cache (the key is the space id, so one
 * tenant's entry never answers for another). The cache is trusted only to say
 * "running": a cached stop is confirmed by a fresh read before `check` reports
 * it, so a resume made by any process counts for every later action at once,
 * while a stop still reaches every reader within the TTL. A failed read rejects
 * instead of reporting "running"; callers decide how to fail.
 */
export function createEmergencyStopReader(
  prisma: Pick<PrismaClient, "extControlStop">,
  options: { ttlMs?: number; now?: () => number } = {},
): EmergencyStopReader {
  const ttlMs = options.ttlMs ?? EMERGENCY_STOP_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; stops: Promise<ActiveStop[]> }>();

  /** Read from the database and remember the answer. */
  const fetch = (spaceId: string): Promise<ActiveStop[]> => {
    const at = now();
    if (cache.size >= MAX_CACHED_SPACES) {
      for (const [key, entry] of cache) if (at - entry.at >= ttlMs) cache.delete(key);
      if (cache.size >= MAX_CACHED_SPACES) cache.clear();
    }
    const stops = prisma.extControlStop
      .findMany({
        where: { resumedAt: null, OR: [{ scope: "global" }, { spaceId }] },
        select: STOP_SELECT,
        orderBy: { stoppedAt: "asc" },
      })
      .then((rows: StopRow[]) => rows.map(toActiveStop));
    const entry = { at, stops };
    cache.set(spaceId, entry);
    // A failed read is not cached: the next check asks the database again.
    stops.catch(() => {
      if (cache.get(spaceId) === entry) cache.delete(spaceId);
    });
    return stops;
  };

  const cached = (spaceId: string): { stops: Promise<ActiveStop[]>; fresh: boolean } => {
    const entry = cache.get(spaceId);
    if (entry && now() - entry.at < ttlMs) return { stops: entry.stops, fresh: false };
    return { stops: fetch(spaceId), fresh: true };
  };

  return {
    activeStops: (spaceId) => cached(spaceId).stops,
    async check(target) {
      const read = cached(target.spaceId);
      const stop = resolveStop(await read.stops, target);
      if (!stop || read.fresh) return stop;
      // Only acted on once confirmed: the cached stop may have been resumed elsewhere.
      return resolveStop(await fetch(target.spaceId), target);
    },
    invalidate(spaceId) {
      if (spaceId) cache.delete(spaceId);
      else cache.clear();
    },
  };
}

let installed: EmergencyStopReader | null = null;

/**
 * Process-wide reader the run, routine, inbound and outbound paths consult.
 * Composition roots install one when EXT_EMERGENCY_STOP=1; with none
 * installed nothing changes.
 */
export function installEmergencyStop(reader: EmergencyStopReader | null): void {
  installed = reader;
}

export function getEmergencyStop(): EmergencyStopReader | null {
  return installed;
}

/** Advisory-lock key that serializes stop and resume writes for one target. */
export function stopLockKey(target: StopTarget): string {
  if (target.scope === "global") return "ext_control:global";
  if (target.scope === "space") return `ext_control:space:${target.spaceId}`;
  return `ext_control:bot:${target.spaceId}:${target.botId}`;
}

function targetWhere(target: StopTarget) {
  return {
    scope: target.scope,
    spaceId: target.spaceId,
    botId: target.botId,
    resumedAt: null,
  };
}

async function lockTarget(tx: Prisma.TransactionClient, target: StopTarget): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${stopLockKey(target)}))`;
}

/** Record a stop, or return the one already active for this target. */
export async function recordStop(
  prisma: Pick<PrismaClient, "$transaction">,
  input: StopTarget & { reason: string; userId: string; at?: Date },
): Promise<{ stop: ActiveStop; created: boolean }> {
  const target: StopTarget = { scope: input.scope, spaceId: input.spaceId, botId: input.botId };
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await lockTarget(tx, target);
      const existing = await tx.extControlStop.findFirst({
        where: targetWhere(target),
        select: STOP_SELECT,
        orderBy: { stoppedAt: "asc" },
      });
      if (existing) return { stop: toActiveStop(existing), created: false };
      const row = await tx.extControlStop.create({
        data: {
          id: randomUUID(),
          ...target,
          reason: input.reason,
          stoppedBy: input.userId,
          stoppedAt: input.at ?? new Date(),
        },
        select: STOP_SELECT,
      });
      return { stop: toActiveStop(row), created: true };
    }),
  );
}

/**
 * Resume this exact target (a space resume does not lift a bot stop, and a
 * bot resume cannot lift its space's stop). `beforeCommit` runs inside the
 * transaction with the rows being resumed, so a failure there (the audit
 * insert) leaves the stop in place.
 */
export async function recordResume(
  prisma: Pick<PrismaClient, "$transaction">,
  input: StopTarget & { userId: string; at?: Date },
  beforeCommit?: (tx: Prisma.TransactionClient, resumed: ActiveStop[]) => Promise<void>,
): Promise<ActiveStop[]> {
  const target: StopTarget = { scope: input.scope, spaceId: input.spaceId, botId: input.botId };
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await lockTarget(tx, target);
      const rows = await tx.extControlStop.findMany({
        where: targetWhere(target),
        select: STOP_SELECT,
      });
      if (rows.length === 0) return [];
      await tx.extControlStop.updateMany({
        where: { id: { in: rows.map((row) => row.id) }, resumedAt: null },
        data: { resumedAt: input.at ?? new Date(), resumedBy: input.userId },
      });
      const resumed = rows.map(toActiveStop);
      await beforeCommit?.(tx, resumed);
      return resumed;
    }),
  );
}

export interface CancelledRuns {
  runIds: string[];
  /** Latest event per touched thread, for realtime notification after commit. */
  threads: Array<{ threadId: string; seq: number }>;
}

/** Runs cancelled per transaction; each run appends an event under its thread's lock. */
export const STOP_CANCEL_BATCH = 100;
/** Explicit, generous per-batch timeout (Prisma's default is 5 seconds). */
const STOP_CANCEL_TIMEOUT_MS = 30_000;

/**
 * Cancel the matching runs and append one `run.cancelled` per run in the same
 * commit, in batches of STOP_CANCEL_BATCH so a large space or global stop
 * never holds one long transaction. The caller chooses the statuses: the API
 * leaves `running` runs to their worker, which halts them at the next guard
 * and lets an in-flight tool call finish first.
 */
export async function cancelRunsForStop(
  prisma: Pick<PrismaClient, "$transaction" | "run">,
  filter: {
    statuses: readonly string[];
    spaceId?: string | null;
    botId?: string | null;
    runIds?: readonly string[];
  },
  at: Date = new Date(),
  options: {
    /** A system note posted in each cancelled run's thread, in the same commit as the cancel. */
    notice?: string;
  } = {},
): Promise<CancelledRuns> {
  const where = {
    status: { in: [...filter.statuses] },
    ...(filter.spaceId ? { spaceId: filter.spaceId } : {}),
    ...(filter.botId ? { botId: filter.botId } : {}),
    ...(filter.runIds ? { id: { in: [...filter.runIds] } } : {}),
  };
  const runIds: string[] = [];
  const latest = new Map<string, number>();
  for (;;) {
    const batch = await prisma.run.findMany({
      where,
      select: { id: true },
      orderBy: { id: "asc" },
      take: STOP_CANCEL_BATCH,
    });
    if (batch.length === 0) break;
    const done = await cancelBatch(
      prisma,
      batch.map((run) => run.id),
      filter.statuses,
      at,
      options.notice,
    );
    runIds.push(...done.runIds);
    for (const { threadId, seq } of done.threads) {
      latest.set(threadId, Math.max(seq, latest.get(threadId) ?? -1));
    }
    // Runs that changed status meanwhile no longer match; anything left is the next batch.
    if (batch.length < STOP_CANCEL_BATCH || done.runIds.length === 0) break;
  }
  return { runIds, threads: [...latest].map(([threadId, seq]) => ({ threadId, seq })) };
}

async function cancelBatch(
  prisma: Pick<PrismaClient, "$transaction">,
  ids: string[],
  statuses: readonly string[],
  at: Date,
  notice: string | undefined,
): Promise<CancelledRuns> {
  return withTransactionRetry(() =>
    prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const cancelled = await tx.run.updateManyAndReturn({
          where: { id: { in: ids }, status: { in: [...statuses] } },
          data: { status: "cancelled", completedAt: at, leaseOwner: null, leaseExpiresAt: null },
          select: { id: true, taskId: true, threadId: true, spaceId: true, botId: true },
        });
        if (cancelled.length === 0) return { runIds: [], threads: [] };
        const runIds = cancelled.map((run) => run.id);
        await tx.attempt.updateMany({
          where: { runId: { in: runIds }, status: "running" },
          data: { status: "cancelled", finishedAt: at },
        });
        await tx.task.updateMany({
          where: { id: { in: cancelled.map((run) => run.taskId) } },
          data: { status: "cancelled" },
        });
        const latest = new Map<string, number>();
        // One lock order (thread id) so concurrent stops never deadlock on thread rows.
        for (const run of [...cancelled].sort((a, b) => a.threadId.localeCompare(b.threadId))) {
          if (notice) {
            // The reason commits with the cancellation: nobody sees one without the other.
            const blocks: MessageBlock[] = [{ kind: "meta", text: notice }];
            const message = await createThreadMessageInTransaction(tx, {
              threadId: run.threadId,
              role: "system",
              blocks,
              botId: run.botId,
              clientNonce: `ext-stop-paused:${run.id}`,
              markUnread: true,
            });
            await appendEventInTransaction(tx, {
              spaceId: run.spaceId,
              threadId: run.threadId,
              botId: run.botId,
              type: "thread.message.created",
              payload: { messageId: message.id, role: "system", blocks },
            });
          }
          const event = await appendEventInTransaction(tx, {
            spaceId: run.spaceId,
            threadId: run.threadId,
            botId: run.botId,
            type: "run.cancelled",
            runId: run.id,
            payload: {},
          });
          latest.set(run.threadId, event.seq);
        }
        await tx.event.deleteMany({ where: { type: "thread.progress", runId: { in: runIds } } });
        return {
          runIds,
          threads: [...latest].map(([threadId, seq]) => ({ threadId, seq })),
        };
      },
      { timeout: STOP_CANCEL_TIMEOUT_MS },
    ),
  );
}
