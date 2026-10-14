import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile as writeFileToDisk } from "node:fs/promises";
import path from "node:path";
import { redactSecrets, sanitizeJsonValue } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { withTransactionRetry } from "./transaction-retry.js";

/**
 * Fork extension: tamper-evident audit log (spec section 5.4).
 *
 * Every event in a space chains to the previous one: `hash` is sha256 over
 * `prevHash` plus the canonical JSON of the event. Rows are append-only at
 * the database (see the migration's triggers), so an altered or removed row
 * shows up as a chain break that `verifyAuditChain` pinpoints by sequence.
 *
 * The writer fails closed: a failed insert raises AuditWriteError, which
 * carries an `errorRef` for the generic error shown to callers and nothing
 * else about the failure.
 */

export const AUDIT_EVENT_KINDS = [
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
] as const;
export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number];

export interface AuditActor {
  type: "bot" | "human" | "system";
  id: string;
}

export interface AuditModelUsage {
  provider: string;
  id: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AuditEventInput {
  /** From the authenticated session or a verified webhook's linked account, never from input. */
  spaceId: string;
  botId?: string | null;
  runId?: string | null;
  actor: AuditActor;
  kind: AuditEventKind;
  /** Human-readable; scrubbed of known secret values and token-shaped text. */
  summary: string;
  /** Structured; secret-named keys keep their name and lose their value. */
  detail?: unknown;
  model?: AuditModelUsage;
  /** Known secret values to scrub from the summary and detail. */
  secrets?: string[];
  at?: Date;
}

export interface AuditEvent {
  id: string;
  spaceId: string;
  seq: number;
  botId: string | null;
  runId: string | null;
  /** ISO time; hashed as this string, stored as a millisecond timestamp. */
  at: string;
  actor: AuditActor;
  kind: AuditEventKind;
  summary: string;
  detail: unknown;
  model?: AuditModelUsage;
  prevHash: string;
  hash: string;
}

export const AUDIT_GENESIS_HASH = "0".repeat(64);
export const AUDIT_PAGE_LIMIT = 100;

export type AuditRow = {
  id: string;
  spaceId: string;
  seq: number;
  botId: string | null;
  runId: string | null;
  at: Date;
  actorType: string;
  actorId: string;
  kind: string;
  summary: string;
  detail: unknown;
  model: unknown;
  prevHash: string;
  hash: string;
};

/** Deterministic JSON: sorted object keys, JSON.stringify semantics otherwise. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
      return sortKeys((value as { toJSON: () => unknown }).toJSON());
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) sorted[key] = sortKeys(member);
    }
    return sorted;
  }
  return value;
}

/** The fields that are hashed, in the shape the verifier recomputes them from a row. */
export function auditHashPayload(
  event: Omit<AuditEvent, "hash" | "prevHash"> & { prevHash?: string },
) {
  return {
    id: event.id,
    spaceId: event.spaceId,
    seq: event.seq,
    botId: event.botId ?? null,
    runId: event.runId ?? null,
    at: event.at,
    actor: { type: event.actor.type, id: event.actor.id },
    kind: event.kind,
    summary: event.summary,
    detail: event.detail,
    ...(event.model ? { model: event.model } : {}),
  };
}

export function hashAuditEvent(
  prevHash: string,
  event: Omit<AuditEvent, "hash" | "prevHash"> & { prevHash?: string },
): string {
  return createHash("sha256")
    .update(prevHash + canonicalJson(auditHashPayload(event)))
    .digest("hex");
}

const SENSITIVE_KEY =
  /password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key|bearer|session[_-]?id/i;
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[oprsu]_[A-Za-z0-9]{20,}/g,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];
const KEY_VALUE_PATTERN =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*["']?[^\s"',;]+/gi;
const MAX_STRING = 512;
const MAX_DEPTH = 8;
const MAX_ITEMS = 100;

/** Scrub known secret values, token-shaped strings and `key=value` secrets from free text. */
export function redactAuditText(text: string, secrets: string[] = []): string {
  let out = redactSecrets(
    text,
    [...secrets].sort((a, b) => b.length - a.length),
  );
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, "[redacted]");
  out = out.replace(KEY_VALUE_PATTERN, (_match, key: string) => `${key}=[redacted]`);
  return out.replaceAll("\u0000", "");
}

/**
 * Redact a structured value for the audit log: secret-named keys keep the name
 * and lose the value, strings are scrubbed and truncated, and depth and
 * breadth are bounded so one event cannot carry a file.
 */
export function redactAuditValue(value: unknown, options: { secrets?: string[] } = {}): unknown {
  return sanitizeJsonValue(redactNode(value, options.secrets ?? [], 0));
}

function redactNode(value: unknown, secrets: string[], depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return truncate(redactAuditText(value, secrets));
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => redactNode(item, secrets, depth + 1));
    if (value.length > MAX_ITEMS) items.push(`[+${value.length - MAX_ITEMS} more]`);
    return items;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, member]) => member !== undefined,
    );
    for (const [key, member] of entries.slice(0, MAX_ITEMS)) {
      out[truncate(key)] = SENSITIVE_KEY.test(key)
        ? "[redacted]"
        : redactNode(member, secrets, depth + 1);
    }
    if (entries.length > MAX_ITEMS) out["…"] = `[+${entries.length - MAX_ITEMS} more]`;
    return out;
  }
  return String(value);
}

function truncate(text: string): string {
  if (text.length <= MAX_STRING) return text;
  return `${text.slice(0, MAX_STRING)}…[+${text.length - MAX_STRING} chars]`;
}

/** A failed audit write. The message is safe to show; the cause is only logged. */
export class AuditWriteError extends Error {
  readonly errorRef: string;

  constructor(cause: unknown, errorRef: string = randomUUID()) {
    super(`Internal error (error_id: ${errorRef})`, { cause });
    this.name = "AuditWriteError";
    this.errorRef = errorRef;
  }

  static from(error: unknown): AuditWriteError {
    if (error instanceof AuditWriteError) return error;
    const wrapped = new AuditWriteError(error);
    getLogger().error("audit write failed", error, { "error.id": wrapped.errorRef });
    return wrapped;
  }
}

export interface AuditWriter {
  /** Append in its own transaction. */
  record(input: AuditEventInput): Promise<AuditEvent>;
  /** Append inside the caller's transaction, so the action and its record commit or roll back together. */
  recordInTransaction(tx: Prisma.TransactionClient, input: AuditEventInput): Promise<AuditEvent>;
}

type ChainTx = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw"> & {
  extAuditEvent: Pick<Prisma.TransactionClient["extAuditEvent"], "create">;
  extAuditChainHead: Pick<Prisma.TransactionClient["extAuditChainHead"], "update">;
};

export function createAuditWriter(
  prisma: Pick<PrismaClient, "$transaction">,
  options: { now?: () => Date; id?: () => string } = {},
): AuditWriter {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? randomUUID;

  async function recordInTransaction(
    client: Prisma.TransactionClient,
    input: AuditEventInput,
  ): Promise<AuditEvent> {
    try {
      if (!AUDIT_EVENT_KINDS.includes(input.kind)) {
        throw new TypeError(`Unknown audit event kind: ${String(input.kind)}`);
      }
      const tx = client as ChainTx;
      const secrets = input.secrets ?? [];
      // Serialize writers per space: the head row is the lock and the chain tip.
      await tx.$executeRaw`
        INSERT INTO "ext_audit_chain_heads" ("spaceId", "lastSeq", "lastHash", "sealedThroughSeq", "updatedAt")
        VALUES (${input.spaceId}, -1, ${AUDIT_GENESIS_HASH}, -1, NOW())
        ON CONFLICT ("spaceId") DO NOTHING`;
      const [head] = await tx.$queryRaw<Array<{ lastSeq: number; lastHash: string }>>`
        SELECT "lastSeq", "lastHash" FROM "ext_audit_chain_heads"
        WHERE "spaceId" = ${input.spaceId} FOR UPDATE`;
      if (!head) throw new Error("audit chain head missing after insert");
      const at = input.at ?? now();
      const unhashed = {
        id: id(),
        spaceId: input.spaceId,
        seq: head.lastSeq + 1,
        botId: input.botId ?? null,
        runId: input.runId ?? null,
        at: at.toISOString(),
        actor: { type: input.actor.type, id: input.actor.id },
        kind: input.kind,
        summary: redactAuditText(input.summary, secrets),
        detail: redactAuditValue(input.detail ?? {}, { secrets }),
        ...(input.model ? { model: input.model } : {}),
      };
      const event: AuditEvent = {
        ...unhashed,
        prevHash: head.lastHash,
        hash: hashAuditEvent(head.lastHash, unhashed),
      };
      await tx.extAuditEvent.create({
        data: {
          id: event.id,
          spaceId: event.spaceId,
          seq: event.seq,
          botId: event.botId,
          runId: event.runId,
          at,
          actorType: event.actor.type,
          actorId: event.actor.id,
          kind: event.kind,
          summary: event.summary,
          detail: event.detail as Prisma.InputJsonValue,
          model: event.model ? (event.model as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          prevHash: event.prevHash,
          hash: event.hash,
        },
      });
      await tx.extAuditChainHead.update({
        where: { spaceId: event.spaceId },
        data: { lastSeq: event.seq, lastHash: event.hash },
      });
      return event;
    } catch (error) {
      throw AuditWriteError.from(error);
    }
  }

  return {
    recordInTransaction,
    record: (input) =>
      withTransactionRetry(() =>
        prisma.$transaction((tx: Prisma.TransactionClient) => recordInTransaction(tx, input)),
      ),
  };
}

let installed: AuditWriter | null = null;

/**
 * Process-wide writer the message and tool paths consult. Composition roots
 * install one when EXT_AUDIT_LOG=1; with none installed nothing changes.
 */
export function installAuditWriter(writer: AuditWriter | null): void {
  installed = writer;
}

export function getAuditWriter(): AuditWriter | null {
  return installed;
}

export function toAuditEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    spaceId: row.spaceId,
    seq: row.seq,
    botId: row.botId,
    runId: row.runId,
    at: row.at.toISOString(),
    actor: { type: row.actorType as AuditActor["type"], id: row.actorId },
    kind: row.kind as AuditEventKind,
    summary: row.summary,
    detail: row.detail,
    ...(row.model ? { model: row.model as AuditModelUsage } : {}),
    prevHash: row.prevHash,
    hash: row.hash,
  };
}

export interface AuditQuery {
  spaceId: string;
  botId?: string;
  runId?: string;
  from?: Date;
  to?: Date;
  /** Sequence cursor: only events after this one. */
  afterSeq?: number;
  limit?: number;
}

/** Chain-ordered page for one space. The caller supplies the space from auth, never from input. */
export async function listAuditEvents(
  prisma: Pick<PrismaClient, "extAuditEvent">,
  query: AuditQuery,
): Promise<{ events: AuditEvent[]; nextAfterSeq: number | null }> {
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 50)), AUDIT_PAGE_LIMIT);
  const at =
    query.from || query.to
      ? { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) }
      : undefined;
  const rows = await prisma.extAuditEvent.findMany({
    where: {
      spaceId: query.spaceId,
      ...(query.botId ? { botId: query.botId } : {}),
      ...(query.runId ? { runId: query.runId } : {}),
      ...(at ? { at } : {}),
      ...(query.afterSeq !== undefined ? { seq: { gt: query.afterSeq } } : {}),
    },
    orderBy: { seq: "asc" },
    take: limit + 1,
  });
  const page = rows.slice(0, limit).map((row) => toAuditEvent(row as AuditRow));
  const last = page[page.length - 1];
  return { events: page, nextAfterSeq: rows.length > limit && last ? last.seq : null };
}

/** Every space that has started a chain, for the verifier CLI. */
export async function listAuditChainSpaces(
  prisma: Pick<PrismaClient, "extAuditChainHead">,
): Promise<string[]> {
  const heads = await prisma.extAuditChainHead.findMany({
    select: { spaceId: true },
    orderBy: { spaceId: "asc" },
  });
  return heads.map((head) => head.spaceId);
}

export type AuditVerification =
  | { ok: true; spaceId: string; events: number; lastSeq: number | null; lastHash: string }
  | {
      ok: false;
      spaceId: string;
      /** Events verified intact before the break. */
      events: number;
      seq: number;
      eventId?: string;
      segmentId?: string;
      reason: "gap" | "prev_hash" | "hash" | "segment";
      expected: string;
      actual: string;
    };

/** Recompute one space's chain from the rows and report the first break. */
export async function verifyAuditChain(
  prisma: Pick<PrismaClient, "extAuditEvent" | "extAuditSegment">,
  options: { spaceId: string; batchSize?: number },
): Promise<AuditVerification> {
  const { spaceId } = options;
  const batchSize = options.batchSize ?? 500;
  let expectedSeq = 0;
  let prevHash = AUDIT_GENESIS_HASH;
  let verified = 0;
  for (;;) {
    const rows = (await prisma.extAuditEvent.findMany({
      where: { spaceId, ...(expectedSeq > 0 ? { seq: { gt: expectedSeq - 1 } } : {}) },
      orderBy: { seq: "asc" },
      take: batchSize,
    })) as AuditRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      const fail = (
        reason: "gap" | "prev_hash" | "hash",
        expected: string,
        actual: string,
      ): AuditVerification => ({
        ok: false,
        spaceId,
        events: verified,
        seq: row.seq,
        eventId: row.id,
        reason,
        expected,
        actual,
      });
      if (row.seq !== expectedSeq) return fail("gap", String(expectedSeq), String(row.seq));
      if (row.prevHash !== prevHash) return fail("prev_hash", prevHash, row.prevHash);
      const event = toAuditEvent(row);
      const recomputed = hashAuditEvent(prevHash, event);
      if (recomputed !== row.hash) return fail("hash", recomputed, row.hash);
      prevHash = row.hash;
      expectedSeq = row.seq + 1;
      verified += 1;
    }
    if (rows.length < batchSize) break;
  }
  const segments = await prisma.extAuditSegment.findMany({
    where: { spaceId },
    orderBy: { fromSeq: "asc" },
  });
  for (const segment of segments) {
    const row = (await prisma.extAuditEvent.findUnique({
      where: { spaceId_seq: { spaceId, seq: segment.toSeq } },
    })) as AuditRow | null;
    if (!row || row.hash !== segment.lastHash) {
      return {
        ok: false,
        spaceId,
        events: verified,
        seq: segment.toSeq,
        segmentId: segment.id,
        reason: "segment",
        expected: segment.lastHash,
        actual: row?.hash ?? "",
      };
    }
  }
  return {
    ok: true,
    spaceId,
    events: verified,
    lastSeq: verified > 0 ? expectedSeq - 1 : null,
    lastHash: prevHash,
  };
}

export interface AuditSegmentSeal {
  id: string;
  spaceId: string;
  fromSeq: number;
  toSeq: number;
  lastHash: string;
  sealedAt: string;
  exportPath: string | null;
}

export interface SealOptions {
  /** Optional off-box copy: one JSON-lines file and one seal record per segment. */
  exportDir?: string;
  now?: () => Date;
  id?: () => string;
  writeFile?: (file: string, content: string) => Promise<void>;
}

/**
 * Seal every space's open range: record the chain tip as a segment and
 * optionally export the rows. Export happens before the seal commits, so a
 * failed copy leaves the range open for the next run.
 */
export async function sealAuditSegments(
  prisma: Pick<PrismaClient, "extAuditChainHead" | "extAuditEvent" | "$transaction">,
  options: SealOptions = {},
): Promise<AuditSegmentSeal[]> {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? randomUUID;
  const writeFile = options.writeFile ?? writeExportFile;
  const heads = (await prisma.extAuditChainHead.findMany({})).filter(
    (head) => head.lastSeq > head.sealedThroughSeq,
  );
  const sealed: AuditSegmentSeal[] = [];
  for (const head of heads) {
    const fromSeq = head.sealedThroughSeq + 1;
    const toSeq = head.lastSeq;
    const sealedAt = now();
    let exportPath: string | null = null;
    if (options.exportDir) {
      const rows = (await prisma.extAuditEvent.findMany({
        where: { spaceId: head.spaceId, seq: { gte: fromSeq, lte: toSeq } },
        orderBy: { seq: "asc" },
      })) as AuditRow[];
      const base = path.join(
        options.exportDir,
        head.spaceId.replace(/[^A-Za-z0-9_-]/g, "_"),
        `${pad(fromSeq)}-${pad(toSeq)}`,
      );
      exportPath = `${base}.jsonl`;
      await writeFile(
        exportPath,
        rows.map((row) => `${JSON.stringify(toAuditEvent(row))}\n`).join(""),
      );
      await writeFile(
        `${base}.seal.json`,
        `${JSON.stringify(
          {
            spaceId: head.spaceId,
            fromSeq,
            toSeq,
            lastHash: head.lastHash,
            sealedAt: sealedAt.toISOString(),
            events: rows.length,
          },
          null,
          2,
        )}\n`,
      );
    }
    const seal = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const [current] = await tx.$queryRaw<
        Array<{ spaceId: string; lastSeq: number; lastHash: string; sealedThroughSeq: number }>
      >`
        SELECT "spaceId", "lastSeq", "lastHash", "sealedThroughSeq" FROM "ext_audit_chain_heads"
        WHERE "spaceId" = ${head.spaceId} FOR UPDATE`;
      // Another process sealed in between, or the tip moved under us: leave it for the next run.
      if (!current || current.sealedThroughSeq !== head.sealedThroughSeq || current.lastSeq < toSeq)
        return null;
      const record: AuditSegmentSeal = {
        id: id(),
        spaceId: head.spaceId,
        fromSeq,
        toSeq,
        lastHash: head.lastHash,
        sealedAt: sealedAt.toISOString(),
        exportPath,
      };
      await tx.extAuditSegment.create({ data: { ...record, sealedAt } });
      await tx.extAuditChainHead.update({
        where: { spaceId: head.spaceId },
        data: { sealedThroughSeq: toSeq },
      });
      return record;
    });
    if (seal) sealed.push(seal);
  }
  return sealed;
}

function pad(seq: number): string {
  return String(seq).padStart(10, "0");
}

async function writeExportFile(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileToDisk(file, content, "utf8");
}
