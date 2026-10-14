import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  AUDIT_GENESIS_HASH,
  AuditWriteError,
  type AuditWriter,
  createAuditWriter,
  hashAuditEvent,
  listAuditChainSpaces,
  listAuditEvents,
  sealAuditSegments,
  toAuditEvent,
  verifyAuditChain,
} from "./ext-audit.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("ext audit log (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const spaceA = `audit-space-a-${suffix}`;
  const spaceB = `audit-space-b-${suffix}`;
  const tampered = `audit-space-tamper-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let writer: AuditWriter;

  const event = (spaceId: string, n: number, extra: Record<string, unknown> = {}) => ({
    spaceId,
    botId: `bot-${n % 2}`,
    runId: `run-${suffix}`,
    actor: { type: "bot" as const, id: `bot-${n % 2}` },
    kind: "tool.call" as const,
    summary: `call ${n}`,
    detail: { n, ...extra },
  });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    writer = createAuditWriter(prisma);
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
  });

  afterAll(async () => {
    await close?.();
  });

  it("chains events per space and verifies an untouched chain", async () => {
    const first = await writer.record(event(spaceA, 0));
    const second = await writer.record(event(spaceA, 1));
    const other = await writer.record(event(spaceB, 0));
    expect(first.seq).toBe(0);
    expect(first.prevHash).toBe(AUDIT_GENESIS_HASH);
    expect(second.seq).toBe(1);
    expect(second.prevHash).toBe(first.hash);
    expect(other.seq).toBe(0);
    expect(other.prevHash).toBe(AUDIT_GENESIS_HASH);
    await expect(verifyAuditChain(prisma, { spaceId: spaceA })).resolves.toEqual({
      ok: true,
      spaceId: spaceA,
      events: 2,
      lastSeq: 1,
      lastHash: second.hash,
    });
    await expect(
      prisma.extAuditChainHead.findUnique({ where: { spaceId: spaceA } }),
    ).resolves.toMatchObject({
      lastSeq: 1,
      lastHash: second.hash,
      sealedThroughSeq: -1,
    });
    expect(await listAuditChainSpaces(prisma)).toEqual(expect.arrayContaining([spaceA, spaceB]));
  });

  it("keeps the stored hash verifiable after the detail round-trips through jsonb", async () => {
    const recorded = await writer.record(
      event(spaceA, 2, {
        float: 0.1 + 0.2,
        big: 1e21,
        tiny: 1e-7,
        negative: -42,
        text: 'ünïcode   \\ "quoted" \n newline',
        nested: { z: [1, { b: true, a: null }], a: "" },
        escaped: "Aé😀",
      }),
    );
    const row = await prisma.extAuditEvent.findUniqueOrThrow({ where: { id: recorded.id } });
    const reloaded = toAuditEvent(row);
    expect(hashAuditEvent(reloaded.prevHash, reloaded)).toBe(row.hash);
    expect(reloaded.detail).toEqual(recorded.detail);
    await expect(verifyAuditChain(prisma, { spaceId: spaceA })).resolves.toMatchObject({
      ok: true,
      events: 3,
    });
  });

  it("serializes concurrent writers so sequences stay contiguous and the chain holds", async () => {
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, n) => writer.record(event(spaceA, 10 + n))),
    );
    const seqs = results.map((row) => row.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 24 }, (_, n) => 3 + n));
    await expect(
      verifyAuditChain(prisma, { spaceId: spaceA, batchSize: 5 }),
    ).resolves.toMatchObject({
      ok: true,
      events: 27,
      lastSeq: 26,
    });
  });

  it("rolls the audit row back with the surrounding transaction", async () => {
    const before = await prisma.extAuditChainHead.findUniqueOrThrow({ where: { spaceId: spaceA } });
    await expect(
      prisma.$transaction(async (tx) => {
        await writer.recordInTransaction(tx, event(spaceA, 99));
        throw new Error("the action failed after the audit insert");
      }),
    ).rejects.toThrow("the action failed");
    const after = await prisma.extAuditChainHead.findUniqueOrThrow({ where: { spaceId: spaceA } });
    expect(after.lastSeq).toBe(before.lastSeq);
    expect(after.lastHash).toBe(before.lastHash);
    await expect(
      prisma.extAuditEvent.count({ where: { spaceId: spaceA, seq: { gt: before.lastSeq } } }),
    ).resolves.toBe(0);
  });

  it("writes nothing when the event is rejected before the insert", async () => {
    const before = await prisma.extAuditEvent.count({ where: { spaceId: spaceA } });
    await expect(
      writer.record({ ...event(spaceA, 100), kind: "nope" as never }),
    ).rejects.toBeInstanceOf(AuditWriteError);
    await expect(prisma.extAuditEvent.count({ where: { spaceId: spaceA } })).resolves.toBe(before);
  });

  it("scopes listing to one space and pages by sequence", async () => {
    const page = await listAuditEvents(prisma, { spaceId: spaceA, limit: 10 });
    expect(page.events).toHaveLength(10);
    expect(page.events.map((row) => row.seq)).toEqual(Array.from({ length: 10 }, (_, n) => n));
    expect(page.events.every((row) => row.spaceId === spaceA)).toBe(true);
    expect(page.nextAfterSeq).toBe(9);
    const next = await listAuditEvents(prisma, { spaceId: spaceA, afterSeq: 9, limit: 100 });
    expect(next.events[0]?.seq).toBe(10);
    expect(next.nextAfterSeq).toBeNull();
    const bot1 = await listAuditEvents(prisma, { spaceId: spaceA, botId: "bot-1" });
    expect(bot1.events.length).toBeGreaterThan(0);
    expect(bot1.events.every((row) => row.botId === "bot-1")).toBe(true);
    const spaceBPage = await listAuditEvents(prisma, { spaceId: spaceB });
    expect(spaceBPage.events.map((row) => row.spaceId)).toEqual([spaceB]);
    const windowed = await listAuditEvents(prisma, {
      spaceId: spaceA,
      from: new Date(Date.now() + 60_000),
    });
    expect(windowed.events).toEqual([]);
  });

  it("rejects updates, deletes and truncation of audit rows at the database", async () => {
    const row = await prisma.extAuditEvent.findFirstOrThrow({ where: { spaceId: spaceA } });
    await expect(
      prisma.extAuditEvent.update({ where: { id: row.id }, data: { summary: "edited" } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.extAuditEvent.delete({ where: { id: row.id } })).rejects.toThrow(
      /append-only/,
    );
    await expect(prisma.extAuditEvent.deleteMany({ where: { spaceId: spaceA } })).rejects.toThrow(
      /append-only/,
    );
    await expect(prisma.$executeRawUnsafe('TRUNCATE "ext_audit_events"')).rejects.toThrow(
      /append-only/,
    );
    await expect(
      prisma.extAuditEvent.findUniqueOrThrow({ where: { id: row.id } }),
    ).resolves.toMatchObject({ summary: row.summary });
  });

  it("pinpoints a manually altered row and a removed row", async () => {
    for (let n = 0; n < 5; n += 1) await writer.record(event(tampered, n));
    await expect(verifyAuditChain(prisma, { spaceId: tampered })).resolves.toMatchObject({
      ok: true,
      events: 5,
    });
    // A database administrator bypasses the trigger; the chain still tells.
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "ext_audit_events" DISABLE TRIGGER ext_audit_events_append_only',
    );
    try {
      await prisma.$executeRaw`UPDATE "ext_audit_events" SET "summary" = 'altered' WHERE "spaceId" = ${tampered} AND "seq" = 2`;
      await expect(verifyAuditChain(prisma, { spaceId: tampered })).resolves.toMatchObject({
        ok: false,
        seq: 2,
        reason: "hash",
        events: 2,
      });
      await prisma.$executeRaw`DELETE FROM "ext_audit_events" WHERE "spaceId" = ${tampered} AND "seq" = 1`;
      await expect(verifyAuditChain(prisma, { spaceId: tampered })).resolves.toMatchObject({
        ok: false,
        seq: 2,
        reason: "gap",
        events: 1,
      });
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "ext_audit_events" ENABLE TRIGGER ext_audit_events_append_only',
      );
    }
    // The altered chain keeps accepting appends; the break stays visible.
    await writer.record(event(tampered, 5));
    await expect(verifyAuditChain(prisma, { spaceId: tampered })).resolves.toMatchObject({
      ok: false,
      seq: 2,
    });
  });

  it("seals the open range per space, exports it, and keeps sealed segments immutable", async () => {
    const exportDir = mkdtempSync(path.join(tmpdir(), "rakazo-audit-export-"));
    const sealed = await sealAuditSegments(prisma, { exportDir });
    const mine = sealed.filter((segment) => segment.spaceId === spaceA);
    expect(mine).toHaveLength(1);
    const segment = mine[0]!;
    const head = await prisma.extAuditChainHead.findUniqueOrThrow({ where: { spaceId: spaceA } });
    expect(segment).toMatchObject({ fromSeq: 0, toSeq: head.lastSeq, lastHash: head.lastHash });
    expect(head.sealedThroughSeq).toBe(head.lastSeq);
    const lines = readFileSync(segment.exportPath!, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(head.lastSeq + 1);
    expect(JSON.parse(lines[lines.length - 1]!)).toMatchObject({
      seq: head.lastSeq,
      hash: head.lastHash,
    });
    const seal = JSON.parse(
      readFileSync(segment.exportPath!.replace(/\.jsonl$/, ".seal.json"), "utf8"),
    );
    expect(seal).toMatchObject({
      spaceId: spaceA,
      fromSeq: 0,
      toSeq: head.lastSeq,
      lastHash: head.lastHash,
    });

    // Nothing new: nothing to seal. New events: the next segment starts after the last seal.
    expect((await sealAuditSegments(prisma)).filter((s) => s.spaceId === spaceA)).toEqual([]);
    await writer.record(event(spaceA, 200));
    const again = (await sealAuditSegments(prisma)).filter((s) => s.spaceId === spaceA);
    expect(again).toMatchObject([{ fromSeq: head.lastSeq + 1, toSeq: head.lastSeq + 1 }]);
    await expect(verifyAuditChain(prisma, { spaceId: spaceA })).resolves.toMatchObject({
      ok: true,
    });

    const stored = await prisma.extAuditSegment.findFirstOrThrow({ where: { id: segment.id } });
    await expect(
      prisma.extAuditSegment.update({ where: { id: stored.id }, data: { lastHash: "x" } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.extAuditSegment.delete({ where: { id: stored.id } })).rejects.toThrow(
      /append-only/,
    );
  });
});
