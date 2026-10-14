import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { AuditWriteError, installAuditWriter } from "./ext-audit.js";
import {
  createThreadMessage,
  createThreadMessageInTransaction,
  RunHistoryWriteError,
} from "./messages.js";

function transaction() {
  return {
    thread: { update: vi.fn().mockResolvedValue({ nextMessageSeq: 1 }) },
    run: { findUnique: vi.fn().mockResolvedValue({ status: "running" }) },
    message: { create: vi.fn().mockResolvedValue({ id: "message-1" }) },
  };
}

describe("createThreadMessageInTransaction", () => {
  it("allows an automated bot message to opt out of unread without changing the default", async () => {
    const silent = transaction();
    await createThreadMessageInTransaction(silent as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "steps", steps: [{ label: "Checked status", count: 1 }] }],
      markUnread: false,
    });
    expect(silent.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unread: undefined }) }),
    );

    const visible = transaction();
    await createThreadMessageInTransaction(visible as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      blocks: [{ kind: "text", text: "Daily report ready" }],
    });
    expect(visible.thread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ unread: true }) }),
    );
  });

  it("rejects a cancelled run unless the terminal echo opts in", async () => {
    const tx = transaction();
    tx.run.findUnique.mockResolvedValue({ status: "cancelled", startedAt: new Date() });
    const input = {
      threadId: "thread-1",
      role: "bot" as const,
      blocks: [{ kind: "text" as const, text: "Stopped. This stayed queued without starting." }],
      runId: "run-1",
    };
    await expect(
      createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, input),
    ).rejects.toBeInstanceOf(RunHistoryWriteError);
    await createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
      ...input,
      allowCancelledRun: true,
    });
    expect(tx.message.create).toHaveBeenCalledOnce();
  });
});

describe("createThreadMessage", () => {
  it("reruns the whole transaction after a mid-write deadlock", async () => {
    const deadlock = Object.assign(new Error("write conflict or a deadlock"), { code: "P2034" });
    const tx = transaction();
    // The sequence already advanced when the insert deadlocks; Postgres rolls both back.
    tx.message.create.mockRejectedValueOnce(deadlock);
    const run = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));

    await expect(
      createThreadMessage({ $transaction: run } as unknown as PrismaClient, {
        threadId: "thread-1",
        role: "bot",
        blocks: [{ kind: "text", text: "Done" }],
      }),
    ).resolves.toEqual({ id: "message-1" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(tx.thread.update).toHaveBeenCalledTimes(2);
    expect(tx.message.create).toHaveBeenCalledTimes(2);
  });

  it("does not retry other errors", async () => {
    const run = vi.fn().mockRejectedValue(new Error("unique constraint"));

    await expect(
      createThreadMessage({ $transaction: run } as unknown as PrismaClient, {
        threadId: "thread-1",
        role: "user",
        blocks: [{ kind: "text", text: "hi" }],
      }),
    ).rejects.toThrow("unique constraint");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("createThreadMessageInTransaction audit log", () => {
  afterEach(() => {
    installAuditWriter(null);
  });

  function auditedTransaction() {
    const tx = transaction();
    tx.thread.update.mockResolvedValue({
      nextMessageSeq: 4,
      spaceId: "space-from-thread",
      userId: "owner-1",
      botId: "bot-1",
    });
    const recordInTransaction = vi.fn(async (_tx: unknown, _event: Record<string, unknown>) => ({
      id: "audit-1",
    }));
    installAuditWriter({ recordInTransaction, record: vi.fn() } as never);
    return { tx, recordInTransaction };
  }

  it("changes nothing while no writer is installed", async () => {
    const tx = transaction();
    await createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "user",
      blocks: [{ kind: "text", text: "hi" }],
    });
    expect(tx.message.create).toHaveBeenCalledOnce();
  });

  it("records an inbound message with the space taken from the thread, not the caller", async () => {
    const { tx, recordInTransaction } = auditedTransaction();
    await createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "user",
      userId: "sender-1",
      blocks: [{ kind: "text", text: "my password is hunter2" }],
      runId: "run-1",
      // A caller cannot pick the space: the field does not exist on the input.
      ...({ spaceId: "spoofed-space" } as object),
    });
    expect(recordInTransaction).toHaveBeenCalledOnce();
    const [client, event] = recordInTransaction.mock.calls[0]!;
    expect(client).toBe(tx);
    expect(event).toMatchObject({
      spaceId: "space-from-thread",
      botId: "bot-1",
      runId: "run-1",
      actor: { type: "human", id: "sender-1" },
      kind: "message.in",
      detail: { threadId: "thread-1", seq: 3, role: "user", blocks: ["text"] },
    });
    expect(JSON.stringify(event)).not.toContain("hunter2");
    expect(JSON.stringify(event)).not.toContain("spoofed");
  });

  it("records an outbound bot message as the bot and falls back to the thread owner for people", async () => {
    const { tx, recordInTransaction } = auditedTransaction();
    await createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "bot",
      botId: "bot-2",
      blocks: [{ kind: "text", text: "done" }],
    });
    await createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "user",
      blocks: [{ kind: "text", text: "thanks" }],
    });
    expect(recordInTransaction.mock.calls[0]?.[1]).toMatchObject({
      kind: "message.out",
      botId: "bot-2",
      actor: { type: "bot", id: "bot-2" },
    });
    expect(recordInTransaction.mock.calls[1]?.[1]).toMatchObject({
      kind: "message.in",
      actor: { type: "human", id: "owner-1" },
    });
  });

  it("attributes a delivered bot-to-bot message to the sending bot", async () => {
    const { tx, recordInTransaction } = auditedTransaction();
    await createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "user",
      blocks: [
        { kind: "bot_message_received", fromBotId: "bot-9", fromBotName: "Nine", text: "ping" },
      ],
    });
    expect(recordInTransaction.mock.calls[0]?.[1]).toMatchObject({
      kind: "message.in",
      actor: { type: "bot", id: "bot-9" },
    });
  });

  it("does not audit system notes", async () => {
    const { tx, recordInTransaction } = auditedTransaction();
    await createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
      threadId: "thread-1",
      role: "system",
      blocks: [{ kind: "meta", text: "You were added to a group." }],
    });
    expect(recordInTransaction).not.toHaveBeenCalled();
    expect(tx.message.create).toHaveBeenCalledOnce();
  });

  it("fails closed: a failed audit write stops the message before it is written", async () => {
    const { tx, recordInTransaction } = auditedTransaction();
    const failure = new AuditWriteError(new Error("db down"));
    recordInTransaction.mockRejectedValueOnce(failure);
    await expect(
      createThreadMessageInTransaction(tx as unknown as Prisma.TransactionClient, {
        threadId: "thread-1",
        role: "user",
        blocks: [{ kind: "text", text: "hi" }],
      }),
    ).rejects.toBe(failure);
    expect(tx.message.create).not.toHaveBeenCalled();
  });
});
