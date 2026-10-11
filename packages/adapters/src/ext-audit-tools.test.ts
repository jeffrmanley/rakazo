import type { AuditEventInput, AuditWriter } from "@rakazo/db";
import { AuditWriteError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { auditedToolExecution, toolResultAuditDetail } from "./ext-audit-tools.js";

const target = { spaceId: "space-a", botId: "bot-1", runId: "run-1" };

function fakeWriter(options: { failOn?: "tool.call" | "tool.result" } = {}) {
  const recorded: AuditEventInput[] = [];
  const record = vi.fn(async (input: AuditEventInput) => {
    if (options.failOn === input.kind) throw new AuditWriteError(new Error("db down"));
    recorded.push(input);
    return { ...input, id: "e", seq: recorded.length - 1 } as never;
  });
  const writer: AuditWriter = { record, recordInTransaction: vi.fn() as never };
  return { writer, recorded, record };
}

describe("auditedToolExecution", () => {
  it("returns the tool unchanged when no writer is installed", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const wrapped = auditedToolExecution({ audit: null, target, secrets: () => [], execute });
    expect(wrapped).toBe(execute);
  });

  it("records the call before running the tool and the result before returning it", async () => {
    const { writer, recorded, record } = fakeWriter();
    const order: string[] = [];
    record.mockImplementation(async (input) => {
      order.push(input.kind);
      recorded.push(input);
      return input as never;
    });
    const execute = vi.fn(async () => {
      order.push("execute");
      return { path: "a.txt", content: "secret-value inside" };
    });
    const wrapped = auditedToolExecution({
      audit: writer,
      target,
      secrets: () => ["secret-value"],
      execute,
    });
    const result = await wrapped(
      "read_file",
      { path: "a.txt", apiKey: "k-1" },
      "exec-1",
      undefined,
      undefined,
    );
    expect(result).toEqual({ path: "a.txt", content: "secret-value inside" });
    expect(order).toEqual(["tool.call", "execute", "tool.result"]);
    expect(execute).toHaveBeenCalledWith(
      "read_file",
      { path: "a.txt", apiKey: "k-1" },
      "exec-1",
      undefined,
      undefined,
    );
    expect(recorded[0]).toMatchObject({
      ...target,
      actor: { type: "bot", id: "bot-1" },
      kind: "tool.call",
      summary: "Tool read_file called",
      detail: { name: "read_file", executionId: "exec-1", args: { path: "a.txt", apiKey: "k-1" } },
      secrets: ["secret-value"],
    });
    expect(recorded[1]).toMatchObject({
      ...target,
      kind: "tool.result",
      summary: "Tool read_file succeeded",
      detail: { name: "read_file", executionId: "exec-1", outcome: "succeeded" },
    });
    // The result body stays out of the immutable log; only its shape is recorded.
    expect(JSON.stringify(recorded[1]?.detail)).not.toContain("secret-value inside");
    const resultDetail = recorded[1]!.detail as { resultKeys?: string[]; durationMs?: number };
    expect(resultDetail.resultKeys).toEqual(["path", "content"]);
    expect(typeof resultDetail.durationMs).toBe("number");
  });

  it("fails closed before the tool runs when the call cannot be recorded", async () => {
    const { writer } = fakeWriter({ failOn: "tool.call" });
    const execute = vi.fn(async () => "never");
    const onAuditFailure = vi.fn();
    const wrapped = auditedToolExecution({
      audit: writer,
      target,
      secrets: () => [],
      execute,
      onAuditFailure,
    });
    const failure = await wrapped("shell", { command: "rm -rf /" }, "exec-2").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AuditWriteError);
    expect(execute).not.toHaveBeenCalled();
    expect(onAuditFailure).toHaveBeenCalledWith(failure);
  });

  it("withholds the result when the outcome cannot be recorded", async () => {
    const { writer, record } = fakeWriter({ failOn: "tool.result" });
    const execute = vi.fn(async () => ({ data: 42 }));
    const onAuditFailure = vi.fn();
    const wrapped = auditedToolExecution({
      audit: writer,
      target,
      secrets: () => [],
      execute,
      onAuditFailure,
    });
    await expect(wrapped("fetch", {}, "exec-3")).rejects.toBeInstanceOf(AuditWriteError);
    expect(execute).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledTimes(2);
    expect(onAuditFailure).toHaveBeenCalledOnce();
  });

  it("records a thrown tool error as a failed result and rethrows it", async () => {
    const { writer, recorded } = fakeWriter();
    const execute = vi.fn(async () => {
      throw new Error("connector exploded with token=abc");
    });
    const wrapped = auditedToolExecution({
      audit: writer,
      target,
      secrets: () => ["abc"],
      execute,
    });
    await expect(wrapped("fetch", {}, "exec-4")).rejects.toThrow("connector exploded");
    expect(recorded[1]).toMatchObject({
      kind: "tool.result",
      summary: "Tool fetch failed",
      detail: { outcome: "error" },
    });
    expect(JSON.stringify([recorded[1]?.summary, recorded[1]?.detail])).not.toContain("abc");
  });

  it("does not wrap a tool's own failure in an audit failure", async () => {
    const { writer, record } = fakeWriter();
    const execute = vi.fn(async () => {
      throw new Error("boom");
    });
    const wrapped = auditedToolExecution({ audit: writer, target, secrets: () => [], execute });
    const failure = await wrapped("x", {}, "exec-5").catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(AuditWriteError);
    expect(record).toHaveBeenCalledTimes(2);
  });
});

describe("toolResultAuditDetail", () => {
  it("classifies error results, pauses, and plain results without copying their contents", () => {
    expect(toolResultAuditDetail("t", "e", 5, { error: "nope" })).toMatchObject({
      outcome: "error",
      error: "nope",
    });
    expect(
      toolResultAuditDetail("t", "e", 5, {
        kind: "agent_tool_result",
        content: [
          { type: "text", text: "hello" },
          { type: "image", data: "...", mimeType: "image/png" },
        ],
        details: { isError: true, content: [{ type: "text", text: "mcp failed" }] },
      }),
    ).toMatchObject({ outcome: "error", error: "mcp failed", contentTypes: ["text", "image"] });
    expect(
      toolResultAuditDetail("t", "e", 5, {
        kind: "agent_tool_result",
        content: [{ type: "text", text: "Waiting for approval." }],
        details: { approval: "paused" },
      }),
    ).toMatchObject({ outcome: "paused" });
    expect(toolResultAuditDetail("t", "e", 5, "plain text")).toMatchObject({
      outcome: "succeeded",
      resultType: "string",
      resultChars: 10,
    });
    expect(toolResultAuditDetail("t", "e", 5, { a: 1, b: 2 })).toMatchObject({
      outcome: "succeeded",
      resultKeys: ["a", "b"],
    });
    expect(toolResultAuditDetail("t", "e", -3, undefined)).toMatchObject({
      outcome: "succeeded",
      durationMs: 0,
    });
  });
});
