import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import {
  AUDIT_EVENT_KINDS,
  AUDIT_GENESIS_HASH,
  AUDIT_PAGE_LIMIT,
  type AuditEvent,
  type AuditEventInput,
  type AuditRow,
  AuditWriteError,
  auditHashPayload,
  canonicalJson,
  createAuditWriter,
  getAuditWriter,
  hashAuditEvent,
  installAuditWriter,
  listAuditEvents,
  redactAuditText,
  redactAuditValue,
  sealAuditSegments,
  toAuditEvent,
  verifyAuditChain,
} from "./ext-audit.js";
import { withTransactionRetry } from "./transaction-retry.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function input(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    spaceId: "space-a",
    botId: "bot-1",
    runId: "run-1",
    actor: { type: "human", id: "user-1" },
    kind: "message.in",
    summary: "Inbound user message",
    detail: { messageId: "msg-1", seq: 3 },
    ...overrides,
  };
}

/** A fake interactive transaction with an in-memory chain head and event list. */
function fakeTransaction(options: { head?: { lastSeq: number; lastHash: string } } = {}) {
  const head = options.head ?? { lastSeq: -1, lastHash: AUDIT_GENESIS_HASH };
  const rows: Array<Record<string, unknown>> = [];
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ lastSeq: head.lastSeq, lastHash: head.lastHash }]),
    extAuditEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        rows.push(data);
        return data;
      }),
    },
    extAuditChainHead: {
      update: vi.fn(async ({ data }: { data: { lastSeq: number; lastHash: string } }) => {
        head.lastSeq = data.lastSeq;
        head.lastHash = data.lastHash;
        return data;
      }),
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, raw: tx, rows, head };
}

afterEach(() => {
  installAuditWriter(null);
});

describe("canonicalJson", () => {
  it("sorts object keys recursively and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { z: [3, { y: 1, x: 2 }], w: null } })).toBe(
      '{"a":{"w":null,"z":[3,{"x":2,"y":1}]},"b":1}',
    );
  });

  it("drops undefined members the way JSON does and is stable across insertion order", () => {
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it("round-trips through JSON.parse unchanged", () => {
    const value = { n: 0.1 + 0.2, big: 1e21, s: "ünïcode  ", nested: [1, "2", true, null] };
    expect(canonicalJson(JSON.parse(canonicalJson(value)))).toBe(canonicalJson(value));
  });
});

describe("hashAuditEvent", () => {
  const event = {
    id: "00000000-0000-4000-8000-000000000001",
    spaceId: "space-a",
    seq: 0,
    botId: "bot-1",
    runId: null,
    at: "2026-10-11T12:00:00.000Z",
    actor: { type: "human" as const, id: "user-1" },
    kind: "message.in" as const,
    summary: "Inbound user message",
    detail: { messageId: "msg-1" },
    model: undefined,
    prevHash: AUDIT_GENESIS_HASH,
  };

  it("is sha256 over the previous hash and the canonical JSON of the event", () => {
    const payload = auditHashPayload(event);
    expect(Object.keys(payload).sort()).toEqual(
      ["actor", "at", "botId", "detail", "id", "kind", "runId", "seq", "spaceId", "summary"].sort(),
    );
    expect(hashAuditEvent(AUDIT_GENESIS_HASH, event)).toBe(
      sha256(AUDIT_GENESIS_HASH + canonicalJson(payload)),
    );
    expect(hashAuditEvent(AUDIT_GENESIS_HASH, event)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any field or the previous hash changes", () => {
    const base = hashAuditEvent(AUDIT_GENESIS_HASH, event);
    expect(hashAuditEvent("1".repeat(64), event)).not.toBe(base);
    expect(hashAuditEvent(AUDIT_GENESIS_HASH, { ...event, summary: "x" })).not.toBe(base);
    expect(hashAuditEvent(AUDIT_GENESIS_HASH, { ...event, detail: { messageId: "m" } })).not.toBe(
      base,
    );
    expect(hashAuditEvent(AUDIT_GENESIS_HASH, { ...event, seq: 1 })).not.toBe(base);
  });

  it("includes model usage only when present so older rows stay verifiable", () => {
    const withModel = {
      ...event,
      model: { provider: "p", id: "m", inputTokens: 1, outputTokens: 2, costUsd: 0.1 },
    };
    expect("model" in auditHashPayload(event)).toBe(false);
    expect(auditHashPayload(withModel).model).toEqual(withModel.model);
    expect(hashAuditEvent(AUDIT_GENESIS_HASH, withModel)).not.toBe(
      hashAuditEvent(AUDIT_GENESIS_HASH, event),
    );
  });
});

describe("redactAuditValue", () => {
  it("replaces values of secret-named keys and keeps the names", () => {
    expect(
      redactAuditValue({
        apiKey: "sk-live-1234567890abcdef",
        Authorization: "Bearer abc",
        nested: { password: "hunter2", cookie: "a=b", ok: "visible" },
        list: [{ token: "t" }],
      }),
    ).toEqual({
      apiKey: "[redacted]",
      Authorization: "[redacted]",
      nested: { password: "[redacted]", cookie: "[redacted]", ok: "visible" },
      list: [{ token: "[redacted]" }],
    });
  });

  it("scrubs known secret values and token-shaped strings inside free text", () => {
    const text = redactAuditText(
      "curl -H 'Authorization: Bearer eyJabc.def.ghi' https://x --key sk-abcdefghijklmnop1234 and ghp_abcdefghijklmnopqrstuvwxyz0123456789 then xoxb-1234567890-abcdefghij AKIAABCDEFGHIJKLMNOP password=hunter2 secret: shh",
      ["shh"],
    );
    expect(text).not.toContain("eyJabc");
    expect(text).not.toContain("sk-abcdefghijklmnop1234");
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("xoxb-");
    expect(text).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("shh");
    expect(text).toContain("[redacted]");
    expect(text).toContain("https://x");
  });

  it("scrubs private key blocks and JWTs", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIE\nabc\n-----END RSA PRIVATE KEY-----";
    expect(redactAuditText(`key:\n${pem}\nafter`)).toBe("key:\n[redacted]\nafter");
    const jwt = `eyJ${"a".repeat(30)}.${"b".repeat(30)}.${"c".repeat(30)}`;
    expect(redactAuditText(`token ${jwt} end`)).toBe("token [redacted] end");
  });

  it("truncates long strings, limits depth and breadth, and serializes odd types", () => {
    const long = "x".repeat(2_000);
    const out = redactAuditValue({ long, when: new Date("2026-01-01T00:00:00.000Z") }) as Record<
      string,
      unknown
    >;
    expect(typeof out.long).toBe("string");
    expect((out.long as string).length).toBeLessThan(600);
    expect(out.long as string).toMatch(/…\[\+\d+ chars\]$/);
    expect(out.when).toBe("2026-01-01T00:00:00.000Z");

    let deep: unknown = "leaf";
    for (let level = 0; level < 12; level += 1) deep = { level, child: deep };
    expect(canonicalJson(redactAuditValue(deep))).toContain("[truncated]");

    const wide = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i]));
    const redactedWide = redactAuditValue(wide) as Record<string, unknown>;
    expect(Object.keys(redactedWide).length).toBeLessThanOrEqual(101);
    expect(redactedWide["…"]).toMatch(/^\[\+\d+ more\]$/);

    expect(redactAuditValue([1n, () => 1, Symbol("s"), undefined, NaN])).toEqual([
      "1",
      "[function]",
      null,
      null,
      null,
    ]);
  });

  it("removes unpaired surrogates Postgres jsonb rejects", () => {
    const out = redactAuditValue({ text: "ok\uD83Dbroken" }) as { text: string };
    expect(out.text).not.toContain("\uD83D");
  });
});

describe("createAuditWriter", () => {
  it("chains every event to the previous hash under the per-space head lock", async () => {
    const { tx, raw, rows, head } = fakeTransaction();
    const writer = createAuditWriter({} as PrismaClient, {
      now: () => new Date("2026-10-11T12:00:00.000Z"),
      id: (() => {
        let n = 0;
        return () => {
          n += 1;
          return `00000000-0000-4000-8000-00000000000${n}`;
        };
      })(),
    });

    const first = await writer.recordInTransaction(tx, input());
    const second = await writer.recordInTransaction(tx, input({ kind: "message.out" }));

    expect(raw.$executeRaw).toHaveBeenCalledTimes(2);
    expect(raw.$queryRaw).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2);
    expect(first.seq).toBe(0);
    expect(first.prevHash).toBe(AUDIT_GENESIS_HASH);
    expect(first.hash).toBe(hashAuditEvent(AUDIT_GENESIS_HASH, first));
    expect(second.seq).toBe(1);
    expect(second.prevHash).toBe(first.hash);
    expect(second.hash).toBe(hashAuditEvent(first.hash, second));
    expect(head).toEqual({ lastSeq: 1, lastHash: second.hash });
    expect(first.at).toBe("2026-10-11T12:00:00.000Z");
    expect(rows[0]).toMatchObject({
      id: first.id,
      spaceId: "space-a",
      seq: 0,
      actorType: "human",
      actorId: "user-1",
      kind: "message.in",
      hash: first.hash,
    });
  });

  it("stores the hash over exactly what it persists, including redacted detail", async () => {
    const { tx, rows } = fakeTransaction();
    const writer = createAuditWriter({} as PrismaClient);
    const event = await writer.recordInTransaction(
      tx,
      input({
        summary: "Called shell with token=abc123secret",
        detail: { args: { command: "echo abc123secret", apiKey: "k" } },
        secrets: ["abc123secret"],
      }),
    );
    expect(event.summary).toBe("Called shell with token=[redacted]");
    expect(event.detail).toEqual({ args: { command: "echo [redacted]", apiKey: "[redacted]" } });
    expect(rows[0]).toMatchObject({ summary: event.summary, detail: event.detail });
    expect(event.hash).toBe(hashAuditEvent(AUDIT_GENESIS_HASH, event));
  });

  it("wraps any failure in AuditWriteError with an error id and no secret or SQL text", async () => {
    const { tx, raw } = fakeTransaction();
    raw.extAuditEvent.create.mockRejectedValueOnce(
      new Error('insert failed: token=super-secret-value at "ext_audit_events"'),
    );
    const writer = createAuditWriter({} as PrismaClient);
    const failure = await writer
      .recordInTransaction(tx, input({ secrets: ["super-secret-value"] }))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AuditWriteError);
    const wrapped = failure as AuditWriteError;
    expect(wrapped.errorRef).toMatch(/^[0-9a-f-]{36}$/);
    expect(wrapped.message).toBe(`Audit log unavailable (error_id: ${wrapped.errorRef})`);
    expect(wrapped.message).not.toContain("super-secret-value");
    expect(wrapped.message).not.toContain("ext_audit_events");
    expect(wrapped.cause).toBeInstanceOf(Error);
  });

  it("rejects an unknown kind before touching the database", async () => {
    const { tx, raw } = fakeTransaction();
    const writer = createAuditWriter({} as PrismaClient);
    await expect(
      writer.recordInTransaction(tx, input({ kind: "message.sideways" as never })),
    ).rejects.toBeInstanceOf(AuditWriteError);
    expect(raw.$executeRaw).not.toHaveBeenCalled();
  });

  it("record() runs its own transaction and retries a serialization conflict", async () => {
    const { tx, rows } = fakeTransaction();
    const conflict = Object.assign(new Error("deadlock"), { code: "P2034" });
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockImplementation(async (run: (client: typeof tx) => unknown) => run(tx));
    const writer = createAuditWriter({ $transaction: transaction } as unknown as PrismaClient);
    const event = await writer.record(input());
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(1);
    expect(event.seq).toBe(0);
  });

  it("lets a wrapped transaction conflict still be retried by the caller's transaction", async () => {
    const conflict = Object.assign(new Error("deadlock"), { code: "P2034" });
    const { tx, raw } = fakeTransaction();
    raw.extAuditEvent.create.mockRejectedValueOnce(conflict);
    const writer = createAuditWriter({} as PrismaClient);
    let attempts = 0;
    await withTransactionRetry(async () => {
      attempts += 1;
      await writer.recordInTransaction(tx, input());
    });
    expect(attempts).toBe(2);
  });

  it("exposes the spec's event kinds for later modules", () => {
    expect(AUDIT_EVENT_KINDS).toEqual([
      "message.in",
      "message.out",
      "tool.call",
      "tool.result",
      "credential.use",
      "approval.request",
      "approval.decision",
      "verifier.verdict",
      "budget.block",
      "control.stop",
      "control.resume",
      "policy.change",
    ]);
  });
});

describe("installAuditWriter", () => {
  it("is off until a writer is installed and can be uninstalled", () => {
    expect(getAuditWriter()).toBeNull();
    const writer = createAuditWriter({} as PrismaClient);
    installAuditWriter(writer);
    expect(getAuditWriter()).toBe(writer);
    installAuditWriter(null);
    expect(getAuditWriter()).toBeNull();
  });
});

describe("listAuditEvents", () => {
  const row = (seq: number): AuditRow => ({
    id: `id-${seq}`,
    spaceId: "space-a",
    seq,
    botId: "bot-1",
    runId: null,
    at: new Date(`2026-10-11T12:00:0${seq}.000Z`),
    actorType: "bot",
    actorId: "bot-1",
    kind: "tool.call",
    summary: `s${seq}`,
    detail: { seq },
    model: null,
    prevHash: "p",
    hash: "h",
  });

  it("always scopes by the given space and pages by sequence with a capped limit", async () => {
    const findMany = vi.fn(async () => [row(0), row(1), row(2)]);
    const prisma = { extAuditEvent: { findMany } } as unknown as PrismaClient;
    const page = await listAuditEvents(prisma, { spaceId: "space-a", limit: 2 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { spaceId: "space-a" },
        orderBy: { seq: "asc" },
        take: 3,
      }),
    );
    expect(page.events.map((event) => event.seq)).toEqual([0, 1]);
    expect(page.nextAfterSeq).toBe(1);
    expect(page.events[0]).toEqual(toAuditEvent(row(0)));
    expect(page.events[0]?.at).toBe("2026-10-11T12:00:00.000Z");
    expect(page.events[0]?.actor).toEqual({ type: "bot", id: "bot-1" });
  });

  it("applies bot, run, time window and cursor filters and clamps the page size", async () => {
    const findMany = vi.fn(async () => [row(5)]);
    const prisma = { extAuditEvent: { findMany } } as unknown as PrismaClient;
    const from = new Date("2026-10-11T00:00:00.000Z");
    const to = new Date("2026-10-12T00:00:00.000Z");
    const page = await listAuditEvents(prisma, {
      spaceId: "space-a",
      botId: "bot-1",
      runId: "run-1",
      from,
      to,
      afterSeq: 4,
      limit: 10_000,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: "space-a",
          botId: "bot-1",
          runId: "run-1",
          at: { gte: from, lte: to },
          seq: { gt: 4 },
        },
        take: AUDIT_PAGE_LIMIT + 1,
      }),
    );
    expect(page.nextAfterSeq).toBeNull();
    expect(AUDIT_PAGE_LIMIT).toBe(100);
  });

  it("never lets the caller widen the space filter", async () => {
    const findMany = vi.fn(async (_args: { where: { spaceId: string }; take: number }) => []);
    const prisma = { extAuditEvent: { findMany } } as unknown as PrismaClient;
    await listAuditEvents(prisma, { spaceId: "space-a", limit: 0 } as never);
    const call = findMany.mock.calls[0]![0];
    expect(call.where.spaceId).toBe("space-a");
    expect(call.take).toBe(2);
  });
});

describe("verifyAuditChain", () => {
  function chain(count: number, mutate?: (events: AuditEvent[]) => void) {
    const events: AuditEvent[] = [];
    let prevHash = AUDIT_GENESIS_HASH;
    for (let seq = 0; seq < count; seq += 1) {
      const partial = {
        id: `id-${seq}`,
        spaceId: "space-a",
        seq,
        botId: null,
        runId: null,
        at: "2026-10-11T12:00:00.000Z",
        actor: { type: "system" as const, id: "api" },
        kind: "policy.change" as const,
        summary: `s${seq}`,
        detail: { seq },
        prevHash,
      };
      const hash = hashAuditEvent(prevHash, partial);
      events.push({ ...partial, hash });
      prevHash = hash;
    }
    mutate?.(events);
    const rows = events.map((event) => ({
      ...event,
      at: new Date(event.at),
      actorType: event.actor.type,
      actorId: event.actor.id,
      model: event.model ?? null,
    }));
    const findMany = vi.fn(
      async ({ where, take }: { where: { seq?: { gt: number } }; take: number }) =>
        rows.filter((r) => r.seq > (where.seq?.gt ?? -1)).slice(0, take),
    );
    const segments = vi.fn(async () => []);
    const findUnique = vi.fn(
      async ({ where }: { where: { spaceId_seq: { seq: number } } }) =>
        rows.find((r) => r.seq === where.spaceId_seq.seq) ?? null,
    );
    const prisma = {
      extAuditEvent: { findMany, findUnique },
      extAuditSegment: { findMany: segments },
    } as unknown as PrismaClient;
    return { prisma, events, rows, segments };
  }

  it("accepts an untouched chain and reports its tip", async () => {
    const { prisma, events } = chain(7);
    await expect(verifyAuditChain(prisma, { spaceId: "space-a", batchSize: 3 })).resolves.toEqual({
      ok: true,
      spaceId: "space-a",
      events: 7,
      lastSeq: 6,
      lastHash: events[6]?.hash,
    });
  });

  it("accepts an empty chain", async () => {
    const { prisma } = chain(0);
    await expect(verifyAuditChain(prisma, { spaceId: "space-a" })).resolves.toEqual({
      ok: true,
      spaceId: "space-a",
      events: 0,
      lastSeq: null,
      lastHash: AUDIT_GENESIS_HASH,
    });
  });

  it("pinpoints an altered row by its sequence", async () => {
    const { prisma } = chain(5, (events) => {
      events[2]!.summary = "tampered";
    });
    await expect(verifyAuditChain(prisma, { spaceId: "space-a" })).resolves.toMatchObject({
      ok: false,
      seq: 2,
      eventId: "id-2",
      reason: "hash",
      events: 2,
    });
  });

  it("detects a deleted row as a gap and a re-chained row by its previous hash", async () => {
    const deleted = chain(5, (events) => {
      events.splice(1, 1);
    });
    await expect(verifyAuditChain(deleted.prisma, { spaceId: "space-a" })).resolves.toMatchObject({
      ok: false,
      seq: 2,
      reason: "gap",
    });
    const rechained = chain(3, (events) => {
      events[2]!.prevHash = "f".repeat(64);
      events[2]!.hash = hashAuditEvent(events[2]!.prevHash, events[2]!);
    });
    await expect(verifyAuditChain(rechained.prisma, { spaceId: "space-a" })).resolves.toMatchObject(
      { ok: false, seq: 2, reason: "prev_hash" },
    );
  });

  it("checks sealed segments against the events they recorded", async () => {
    const { prisma, events, segments } = chain(4);
    segments.mockResolvedValue([
      { id: "seg-1", spaceId: "space-a", fromSeq: 0, toSeq: 1, lastHash: events[1]!.hash },
      { id: "seg-2", spaceId: "space-a", fromSeq: 2, toSeq: 3, lastHash: "bogus" },
    ] as never);
    await expect(verifyAuditChain(prisma, { spaceId: "space-a" })).resolves.toMatchObject({
      ok: false,
      reason: "segment",
      seq: 3,
      segmentId: "seg-2",
    });
  });
});

describe("sealAuditSegments", () => {
  function fakeSealing(
    heads: Array<{ spaceId: string; lastSeq: number; lastHash: string; sealedThroughSeq: number }>,
  ) {
    const created: Array<Record<string, unknown>> = [];
    const updated: Array<Record<string, unknown>> = [];
    const rows = (spaceId: string) =>
      Array.from({ length: 10 }, (_, seq) => ({
        id: `${spaceId}-${seq}`,
        spaceId,
        seq,
        botId: null,
        runId: null,
        at: new Date("2026-10-11T12:00:00.000Z"),
        actorType: "system",
        actorId: "api",
        kind: "policy.change",
        summary: `s${seq}`,
        detail: {},
        model: null,
        prevHash: "p",
        hash: `h${seq}`,
      }));
    const tx = {
      $queryRaw: vi.fn(async (_sql: unknown, spaceId: string) =>
        heads.filter((head) => head.spaceId === spaceId),
      ),
      extAuditSegment: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return data;
        }),
      },
      extAuditChainHead: {
        update: vi.fn(
          async ({
            where,
            data,
          }: {
            where: { spaceId: string };
            data: Record<string, unknown>;
          }) => {
            updated.push({ ...where, ...data });
            const head = heads.find((h) => h.spaceId === where.spaceId)!;
            head.sealedThroughSeq = data.sealedThroughSeq as number;
            return data;
          },
        ),
      },
    };
    const prisma = {
      extAuditChainHead: {
        findMany: vi.fn(async () => heads.filter((h) => h.lastSeq > h.sealedThroughSeq)),
      },
      extAuditEvent: {
        findMany: vi.fn(
          async ({ where }: { where: { spaceId: string; seq: { gte: number; lte: number } } }) =>
            rows(where.spaceId).filter((r) => r.seq >= where.seq.gte && r.seq <= where.seq.lte),
        ),
      },
      $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)),
    } as unknown as PrismaClient;
    return { prisma, created, updated, tx };
  }

  it("seals the open range of every space and advances the sealed cursor", async () => {
    const heads = [
      { spaceId: "space-a", lastSeq: 4, lastHash: "h4", sealedThroughSeq: -1 },
      { spaceId: "space-b", lastSeq: 9, lastHash: "h9", sealedThroughSeq: 6 },
      { spaceId: "space-c", lastSeq: 2, lastHash: "h2", sealedThroughSeq: 2 },
    ];
    const { prisma, created, updated } = fakeSealing(heads);
    const now = new Date("2026-10-11T13:00:00.000Z");
    const sealed = await sealAuditSegments(prisma, { now: () => now });
    expect(sealed.map((s) => [s.spaceId, s.fromSeq, s.toSeq, s.lastHash])).toEqual([
      ["space-a", 0, 4, "h4"],
      ["space-b", 7, 9, "h9"],
    ]);
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      spaceId: "space-a",
      fromSeq: 0,
      toSeq: 4,
      sealedAt: now,
      exportPath: null,
    });
    expect(updated).toEqual([
      { spaceId: "space-a", sealedThroughSeq: 4 },
      { spaceId: "space-b", sealedThroughSeq: 9 },
    ]);
  });

  it("exports each sealed segment as JSON lines plus a seal record before committing", async () => {
    const heads = [{ spaceId: "space-a", lastSeq: 1, lastHash: "h1", sealedThroughSeq: -1 }];
    const { prisma, created } = fakeSealing(heads);
    const files = new Map<string, string>();
    const sealed = await sealAuditSegments(prisma, {
      exportDir: "/exports",
      now: () => new Date("2026-10-11T13:00:00.000Z"),
      writeFile: async (file, content) => {
        files.set(file, content);
      },
    });
    expect(sealed[0]?.exportPath).toBe("/exports/space-a/0000000000-0000000001.jsonl");
    expect(created[0]).toMatchObject({
      exportPath: "/exports/space-a/0000000000-0000000001.jsonl",
    });
    const lines = files.get("/exports/space-a/0000000000-0000000001.jsonl")?.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines![0]!)).toMatchObject({ seq: 0, hash: "h0", spaceId: "space-a" });
    const seal = JSON.parse(files.get("/exports/space-a/0000000000-0000000001.seal.json")!);
    expect(seal).toMatchObject({ spaceId: "space-a", fromSeq: 0, toSeq: 1, lastHash: "h1" });
  });

  it("does not record a seal when the export fails, so the next run retries it", async () => {
    const heads = [{ spaceId: "space-a", lastSeq: 1, lastHash: "h1", sealedThroughSeq: -1 }];
    const { prisma, created } = fakeSealing(heads);
    await expect(
      sealAuditSegments(prisma, {
        exportDir: "/exports",
        writeFile: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow("disk full");
    expect(created).toHaveLength(0);
    expect(heads[0]?.sealedThroughSeq).toBe(-1);
  });

  it("skips a space another process sealed in between", async () => {
    const heads = [{ spaceId: "space-a", lastSeq: 1, lastHash: "h1", sealedThroughSeq: -1 }];
    const { prisma, created, tx } = fakeSealing(heads);
    tx.$queryRaw.mockResolvedValueOnce([{ ...heads[0]!, sealedThroughSeq: 1 }]);
    await expect(sealAuditSegments(prisma)).resolves.toEqual([]);
    expect(created).toHaveLength(0);
  });

  it("refuses an export directory path it cannot make safe", async () => {
    const heads = [{ spaceId: "../escape", lastSeq: 0, lastHash: "h0", sealedThroughSeq: -1 }];
    const { prisma } = fakeSealing(heads);
    const files: string[] = [];
    await sealAuditSegments(prisma, {
      exportDir: "/exports",
      writeFile: async (file) => {
        files.push(file);
      },
    });
    for (const file of files) expect(file.startsWith("/exports/")).toBe(true);
    for (const file of files) expect(file).not.toContain("..");
  });
});
