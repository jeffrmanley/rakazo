import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { MessagingSurface } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { AuditSegmentSeal, AuditVerification, PrismaClient, SealOptions } from "@rakazo/db";
import { AUDIT_PAGE_LIMIT, AuditWriteError, listAuditEvents, sealAuditSegments } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";

export const AUDIT_API_PATH = "/api/v1/audit";
const DEFAULT_PAGE = 50;
const HOUR_MS = 60 * 60 * 1_000;

/**
 * `GET /api/v1/audit?botId&runId&from&to&cursor&limit`: the session space's
 * chain, in order, at most 100 per page. The space comes from the
 * authenticated actor only; nothing in the query, headers or body can widen it.
 */
export function mountAuditRoutes(
  app: Hono,
  deps: {
    prisma: Pick<PrismaClient, "extAuditEvent">;
    authenticate: (request: Request) => Promise<Actor | null>;
  },
): void {
  app.get(AUDIT_API_PATH, async (c) => {
    const actor = await deps.authenticate(c.req.raw);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    c.header("cache-control", "no-store");
    const query = c.req.query();
    const parsed = parseAuditQuery(query);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    try {
      const page = await listAuditEvents(deps.prisma, { spaceId: actor.spaceId, ...parsed });
      return c.json({
        events: page.events,
        nextCursor: page.nextAfterSeq === null ? null : String(page.nextAfterSeq),
      });
    } catch (error) {
      const errorId = randomUUID();
      getLogger().error("audit list failed", error, { "error.id": errorId });
      return c.json({ error: "Internal error", error_id: errorId }, 500);
    }
  });
}

type ParsedAuditQuery =
  | { botId?: string; runId?: string; from?: Date; to?: Date; afterSeq?: number; limit: number }
  | { error: string };

function parseAuditQuery(query: Record<string, string>): ParsedAuditQuery {
  const out: Exclude<ParsedAuditQuery, { error: string }> = { limit: DEFAULT_PAGE };
  if (query.botId) out.botId = query.botId;
  if (query.runId) out.runId = query.runId;
  for (const key of ["from", "to"] as const) {
    const value = query[key];
    if (!value) continue;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return { error: `${key} must be an ISO 8601 time` };
    out[key] = date;
  }
  if (query.cursor) {
    const afterSeq = Number(query.cursor);
    if (!Number.isInteger(afterSeq) || afterSeq < 0) return { error: "cursor is not valid" };
    out.afterSeq = afterSeq;
  }
  if (query.limit) {
    const limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1) return { error: "limit must be a positive integer" };
    out.limit = Math.min(limit, AUDIT_PAGE_LIMIT);
  }
  return out;
}

/**
 * RPC interceptor: an audit write failure reaches the client as a generic
 * error that carries only the error reference; the cause stays in the log.
 */
export async function auditErrorInterceptor<T>(options: { next: () => Promise<T> }): Promise<T> {
  try {
    return await options.next();
  } catch (error) {
    if (error instanceof AuditWriteError) {
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: error.message,
        data: { error_id: error.errorRef },
      });
    }
    throw error;
  }
}

/** Best-effort reply on the chat line whose message could not be audited and was therefore dropped. */
export async function reportAuditFailureToChat(
  messaging: Pick<MessagingSurface, "sendToThread">,
  event: { threadId: string; handle: string },
  error: AuditWriteError,
): Promise<void> {
  const operationId = `ext-audit-failure:${randomUUID()}`;
  try {
    await messaging.sendToThread(
      {
        threadId: event.threadId,
        body: error.message,
        idempotencyKey: `ext-audit-failure:${event.handle}`,
      },
      {
        operationId,
        traceId: operationId,
        spaceId: "",
        userId: "",
        signal: AbortSignal.timeout(5_000),
      },
    );
  } catch (sendError) {
    getLogger().error("audit failure reply could not be sent", sendError, {
      "error.id": error.errorRef,
    });
  }
}

export interface AuditSealer {
  runNow(): Promise<AuditSegmentSeal[]>;
  stop(): void;
}

/** Hourly: seal every space's open range and copy it to EXT_AUDIT_EXPORT_DIR when set. */
export function startAuditSealer(options: {
  prisma: Parameters<typeof sealAuditSegments>[0];
  exportDir?: string;
  intervalMs?: number;
  seal?: (
    prisma: Parameters<typeof sealAuditSegments>[0],
    options: SealOptions,
  ) => Promise<AuditSegmentSeal[]>;
}): AuditSealer {
  const seal = options.seal ?? sealAuditSegments;
  const sealOptions: SealOptions = options.exportDir ? { exportDir: options.exportDir } : {};
  let running: Promise<AuditSegmentSeal[]> | undefined;
  const runNow = () => {
    if (running) return running;
    running = seal(options.prisma, sealOptions).finally(() => {
      running = undefined;
    });
    return running;
  };
  const timer = setInterval(() => {
    runNow().catch((error) => getLogger().error("audit seal failed", error));
  }, options.intervalMs ?? HOUR_MS);
  timer.unref?.();
  return {
    runNow,
    stop: () => clearInterval(timer),
  };
}

export function formatAuditVerification(result: AuditVerification): string {
  if (result.ok) {
    return `space ${result.spaceId}: ok (${result.events} events, head ${result.lastHash})`;
  }
  const intact = `${result.events} events intact`;
  switch (result.reason) {
    case "gap":
      return `space ${result.spaceId}: BREAK at seq ${result.actual} (gap): expected seq ${result.expected}, found ${result.actual}; ${intact}`;
    case "segment":
      return `space ${result.spaceId}: BREAK at seq ${result.seq} (segment): segment ${result.segmentId} sealed ${result.expected}, event hash ${result.actual}; ${intact}`;
    case "prev_hash":
      return `space ${result.spaceId}: BREAK at seq ${result.seq} (prev_hash): event ${result.eventId} links to ${result.actual}, chain head was ${result.expected}; ${intact}`;
    default:
      return `space ${result.spaceId}: BREAK at seq ${result.seq} (hash): event ${result.eventId} recomputed ${result.expected}, stored ${result.actual}; ${intact}`;
  }
}
