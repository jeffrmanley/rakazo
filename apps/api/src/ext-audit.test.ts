import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { AUDIT_PAGE_LIMIT, AuditWriteError } from "@rakazo/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIT_API_PATH,
  auditErrorInterceptor,
  formatAuditVerification,
  mountAuditRoutes,
  reportAuditFailureToChat,
  startAuditSealer,
} from "./ext-audit.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-a",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};

function row(seq: number) {
  return {
    id: `id-${seq}`,
    spaceId: "space-a",
    seq,
    botId: "bot-1",
    runId: "run-1",
    at: new Date(`2026-10-11T12:00:0${seq}.000Z`),
    actorType: "bot",
    actorId: "bot-1",
    kind: "tool.call",
    summary: `s${seq}`,
    detail: { seq },
    model: null,
    prevHash: "p",
    hash: "h",
  };
}

function mount(options: { actor?: Actor | null; rows?: ReturnType<typeof row>[] } = {}) {
  const findMany = vi.fn(async () => options.rows ?? [row(0), row(1)]);
  const app = new Hono();
  mountAuditRoutes(app, {
    prisma: { extAuditEvent: { findMany } } as unknown as PrismaClient,
    authenticate: async () => (options.actor === undefined ? actor : options.actor),
  });
  return { app, findMany };
}

function whereOf(findMany: ReturnType<typeof vi.fn>) {
  return (
    findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; take: number }]
  )[0];
}

describe("GET /api/v1/audit", () => {
  it("requires a signed-in session", async () => {
    const { app, findMany } = mount({ actor: null });
    const res = await app.request(AUDIT_API_PATH);
    expect(res.status).toBe(401);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns the session space's events in chain order with a cursor", async () => {
    const { app, findMany } = mount({ rows: [row(0), row(1), row(2)] });
    const res = await app.request(`${AUDIT_API_PATH}?limit=2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      events: Array<{ seq: number; at: string }>;
      nextCursor: string | null;
    };
    expect(body.events.map((event) => event.seq)).toEqual([0, 1]);
    expect(body.events[0]?.at).toBe("2026-10-11T12:00:00.000Z");
    expect(body.nextCursor).toBe("1");
    expect(whereOf(findMany).where).toEqual({ spaceId: "space-a" });
    expect(whereOf(findMany).take).toBe(3);
  });

  it("ignores a spaceId in the query or headers and scopes to the session's space", async () => {
    const { app, findMany } = mount();
    const res = await app.request(
      `${AUDIT_API_PATH}?spaceId=space-b&space_id=space-b&space=space-b`,
      {
        headers: { "x-space-id": "space-b" },
      },
    );
    expect(res.status).toBe(200);
    expect(whereOf(findMany).where).toEqual({ spaceId: "space-a" });
    const body = (await res.json()) as { events: Array<{ spaceId: string }> };
    expect(body.events.every((event) => event.spaceId === "space-a")).toBe(true);
  });

  it("does not accept a request body as input", async () => {
    const { app, findMany } = mount();
    const res = await app.request(AUDIT_API_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "space-b" }),
    });
    expect(res.status).toBe(404);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("passes bot, run, time window and cursor filters through", async () => {
    const { app, findMany } = mount({ rows: [] });
    const res = await app.request(
      `${AUDIT_API_PATH}?botId=bot-1&runId=run-1&from=2026-10-11T00:00:00Z&to=2026-10-12T00:00:00Z&cursor=7&limit=5`,
    );
    expect(res.status).toBe(200);
    expect(whereOf(findMany).where).toEqual({
      spaceId: "space-a",
      botId: "bot-1",
      runId: "run-1",
      at: { gte: new Date("2026-10-11T00:00:00Z"), lte: new Date("2026-10-12T00:00:00Z") },
      seq: { gt: 7 },
    });
    expect(whereOf(findMany).take).toBe(6);
    expect(await res.json()).toEqual({ events: [], nextCursor: null });
  });

  it("caps the page at 100 and defaults to 50", async () => {
    const { app, findMany } = mount({ rows: [] });
    await app.request(`${AUDIT_API_PATH}?limit=5000`);
    expect(whereOf(findMany).take).toBe(AUDIT_PAGE_LIMIT + 1);
    findMany.mockClear();
    await app.request(AUDIT_API_PATH);
    expect(whereOf(findMany).take).toBe(51);
  });

  it("rejects malformed filters instead of guessing", async () => {
    const { app, findMany } = mount();
    for (const query of [
      "cursor=abc",
      "cursor=-1",
      "from=yesterday",
      "to=0x",
      "limit=0",
      "limit=x",
    ]) {
      const res = await app.request(`${AUDIT_API_PATH}?${query}`);
      expect(res.status, query).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/cursor|from|to|limit/);
    }
    expect(findMany).not.toHaveBeenCalled();
  });

  it("answers a failing read with a generic error and an error id", async () => {
    const findMany = vi.fn(async () => {
      throw new Error("connection refused to db-host:5432 password=pw");
    });
    const app = new Hono();
    mountAuditRoutes(app, {
      prisma: { extAuditEvent: { findMany } } as unknown as PrismaClient,
      authenticate: async () => actor,
    });
    const res = await app.request(AUDIT_API_PATH);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; error_id: string };
    expect(body.error_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.error).toBe("Internal error");
    expect(JSON.stringify(body)).not.toContain("db-host");
  });
});

describe("auditErrorInterceptor", () => {
  it("turns an audit write failure into a generic RPC error carrying the error id", async () => {
    const failure = new AuditWriteError(new Error("insert failed password=pw"));
    const thrown = await auditErrorInterceptor({
      next: async () => {
        throw failure;
      },
    } as never).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ORPCError);
    const rpcError = thrown as ORPCError<string, { error_id: string }>;
    expect(rpcError.code).toBe("INTERNAL_SERVER_ERROR");
    expect(rpcError.message).toBe(`Internal error (error_id: ${failure.errorRef})`);
    expect(rpcError.data).toEqual({ error_id: failure.errorRef });
    expect(JSON.stringify(rpcError.toJSON())).not.toContain("password");
  });

  it("leaves other errors and results alone", async () => {
    await expect(auditErrorInterceptor({ next: async () => 42 } as never)).resolves.toBe(42);
    const other = new Error("boom");
    await expect(
      auditErrorInterceptor({
        next: async () => {
          throw other;
        },
      } as never),
    ).rejects.toBe(other);
  });
});

describe("reportAuditFailureToChat", () => {
  it("tells the sender the generic message with the error id and never throws", async () => {
    const sendToThread = vi.fn(async () => ({ handle: "h" }));
    const failure = new AuditWriteError(new Error("db down"));
    await reportAuditFailureToChat(
      { sendToThread } as never,
      { threadId: "slack:thread", handle: "evt-1" },
      failure,
    );
    expect(sendToThread).toHaveBeenCalledWith(
      {
        threadId: "slack:thread",
        body: failure.message,
        idempotencyKey: "ext-audit-failure:evt-1",
      },
      expect.objectContaining({ spaceId: "", userId: "" }),
    );
    sendToThread.mockRejectedValueOnce(new Error("provider down"));
    await expect(
      reportAuditFailureToChat(
        { sendToThread } as never,
        { threadId: "slack:thread", handle: "evt-2" },
        failure,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("startAuditSealer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("seals on the hour, keeps going after a failure, and stops cleanly", async () => {
    vi.useFakeTimers();
    const seal = vi
      .fn()
      .mockRejectedValueOnce(new Error("export failed"))
      .mockResolvedValue([{ spaceId: "space-a", fromSeq: 0, toSeq: 3 }]);
    const sealer = startAuditSealer({
      prisma: {} as PrismaClient,
      exportDir: "/exports",
      intervalMs: 1_000,
      seal,
    });
    expect(seal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seal).toHaveBeenCalledTimes(1);
    expect(seal).toHaveBeenCalledWith({}, { exportDir: "/exports" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seal).toHaveBeenCalledTimes(2);
    sealer.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(seal).toHaveBeenCalledTimes(2);
  });

  it("runs on demand for the verifier and tests", async () => {
    const seal = vi.fn(async () => []);
    const sealer = startAuditSealer({ prisma: {} as PrismaClient, intervalMs: 60_000, seal });
    await expect(sealer.runNow()).resolves.toEqual([]);
    sealer.stop();
  });
});

describe("formatAuditVerification", () => {
  it("prints one line per space and names the first break", () => {
    expect(
      formatAuditVerification({
        ok: true,
        spaceId: "space-a",
        events: 12,
        lastSeq: 11,
        lastHash: "abc",
      }),
    ).toBe("space space-a: ok (12 events, head abc)");
    expect(
      formatAuditVerification({
        ok: false,
        spaceId: "space-a",
        events: 4,
        seq: 4,
        eventId: "id-4",
        reason: "hash",
        expected: "e",
        actual: "a",
      }),
    ).toBe(
      "space space-a: BREAK at seq 4 (hash): event id-4 recomputed e, stored a; 4 events intact",
    );
    expect(
      formatAuditVerification({
        ok: false,
        spaceId: "space-a",
        events: 2,
        seq: 2,
        reason: "gap",
        expected: "2",
        actual: "3",
      }),
    ).toBe("space space-a: BREAK at seq 3 (gap): expected seq 2, found 3; 2 events intact");
    expect(
      formatAuditVerification({
        ok: false,
        spaceId: "space-a",
        events: 9,
        seq: 7,
        segmentId: "seg-1",
        reason: "segment",
        expected: "e",
        actual: "a",
      }),
    ).toBe(
      "space space-a: BREAK at seq 7 (segment): segment seg-1 sealed e, event hash a; 9 events intact",
    );
  });
});
