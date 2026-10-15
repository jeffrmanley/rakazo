import { describe, expect, it } from "vitest";
import {
  approvalCallHash,
  approvalEffectKey,
  isToolEffectIdempotencyKey,
  legacyScopedToolEffectIdempotencyKey,
  stableJsonValue,
  toolEffectIdempotencyKey,
} from "./approval-effect-key.js";

describe("stableJsonValue", () => {
  it("sorts object keys", () => {
    expect(stableJsonValue({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("rejects values that cannot be represented uniquely as JSON", () => {
    const sparse = Array(1);

    for (const value of [undefined, [undefined], sparse, { value: undefined }, Number.NaN]) {
      expect(() => stableJsonValue(value)).toThrow("only JSON values");
    }
    expect(stableJsonValue([])).toBe("[]");
    expect(stableJsonValue([null])).toBe("[null]");
  });

  it("rejects cyclic and non-plain objects", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(() => stableJsonValue(cyclic)).toThrow("only JSON values");
    expect(() => stableJsonValue(new Date(0))).toThrow("only JSON values");
  });
});

describe("approvalEffectKey", () => {
  it("includes run and tool with an opaque digest of canonical args", () => {
    const key = approvalEffectKey("run-1", "destination.write", { body: "private draft" });

    expect(key).toMatch(/^run-1:destination\.write:[a-f0-9]{64}$/);
    expect(key).not.toContain("private draft");
  });
});

describe("toolEffectIdempotencyKey", () => {
  it("scopes effects to run, tool, and args without the model tool-call id", () => {
    const write = { path: "a.txt", content: "one" };
    expect(toolEffectIdempotencyKey("run-1", "write_file", write)).toMatch(
      /^run-1:write_file:[a-f0-9]{64}$/,
    );
    expect(toolEffectIdempotencyKey("run-1", "write_file", write)).toBe(
      approvalEffectKey("run-1", "write_file", write),
    );
    expect(toolEffectIdempotencyKey("run-1", "write_file", write)).not.toBe(
      toolEffectIdempotencyKey("run-2", "write_file", write),
    );
    expect(toolEffectIdempotencyKey("run-1", "write_file", write)).not.toBe(
      toolEffectIdempotencyKey("run-1", "shell", write),
    );
    expect(toolEffectIdempotencyKey("run-1", "write_file", write)).not.toBe(
      toolEffectIdempotencyKey("run-1", "write_file", {
        path: "a.txt",
        content: "two",
      }),
    );
    expect(toolEffectIdempotencyKey("run-1", "write_file", write)).not.toContain("call_0");
  });

  it("is stable across replay when the model assigns a new tool-call id", () => {
    const args = { path: "MEMORY.md", content: "fact" };
    expect(toolEffectIdempotencyKey("run-1", "remember", args)).toBe(
      toolEffectIdempotencyKey("run-1", "remember", args),
    );
    expect(legacyScopedToolEffectIdempotencyKey("run-1", "remember", "call_0", args)).not.toBe(
      toolEffectIdempotencyKey("run-1", "remember", args),
    );
  });

  it("distinguishes identical-args calls in one run via occurrence", () => {
    const args = { actions: [{ kind: "click", x: 12, y: 40 }] };
    const first = toolEffectIdempotencyKey("run-1", "computer_act", args);
    const second = toolEffectIdempotencyKey("run-1", "computer_act", args, 1);
    expect(first).toBe(approvalEffectKey("run-1", "computer_act", args));
    expect(second).not.toBe(first);
    expect(second).toBe(`${first}:1`);
    expect(isToolEffectIdempotencyKey(first, "run-1", "computer_act")).toBe(true);
    expect(isToolEffectIdempotencyKey(second, "run-1", "computer_act")).toBe(true);
    expect(
      isToolEffectIdempotencyKey(
        legacyScopedToolEffectIdempotencyKey("run-1", "computer_act", "call_0", args),
        "run-1",
        "computer_act",
      ),
    ).toBe(false);
  });
});

describe("approvalCallHash", () => {
  it("binds one exact call: the same tool and arguments in any key order hash alike", () => {
    const first = approvalCallHash("destination.write", { title: "Q3", body: { a: 1, b: 2 } });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(approvalCallHash("destination.write", { body: { b: 2, a: 1 }, title: "Q3" })).toBe(
      first,
    );
  });

  it("does not match different arguments or another tool", () => {
    const approved = approvalCallHash("gmail_send_email", { to: "a@example.test", body: "hi" });
    expect(approvalCallHash("gmail_send_email", { to: "b@example.test", body: "hi" })).not.toBe(
      approved,
    );
    expect(approvalCallHash("gmail_send_email", { to: "a@example.test" })).not.toBe(approved);
    expect(approvalCallHash("outlook_send_email", { to: "a@example.test", body: "hi" })).not.toBe(
      approved,
    );
  });

  it("cannot be confused by a tool name that looks like part of the arguments", () => {
    expect(approvalCallHash("a", { b: 1 })).not.toBe(approvalCallHash("a:b", {}));
  });
});
