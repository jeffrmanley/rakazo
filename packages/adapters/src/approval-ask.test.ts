import { describe, expect, it } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";

describe("buildApprovalAskBlock", () => {
  it("binds the approval to its effect and redacts secrets", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", body: "token-secret" },
      ["token-secret"],
    );

    expect(block).toMatchObject({
      kind: "ask",
      approvalEffectId: "effect-1",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow this tool" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(JSON.stringify(block)).not.toContain("token-secret");
  });

  it("bounds model-controlled summaries and details", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "destination.write",
      { title: "t".repeat(1_000), body: "b".repeat(10_000) },
      [],
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.text.length).toBeLessThanOrEqual(501);
    expect(block.detail?.length).toBeLessThanOrEqual(4_001);
  });

  it("includes an optional review reason as the first detail line", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", subject: "Hi" },
      [],
      { reviewReason: "Sends email outside the draft-only task." },
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail?.startsWith("Sends email outside the draft-only task.")).toBe(true);
    expect(block.detail).toContain("to: person@example.test");
  });

  it("uses a one-time create or cancel choice for a new security boundary", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "create_space",
      { name: "Customer support" },
      [],
    );

    expect(block).toMatchObject({
      kind: "ask",
      text: "Create space “Customer support”?",
      actions: [
        { id: "allow", label: "Create space", outcome: "created" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ],
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toContain("stay separate from other spaces");
  });

  it("leaves out Always allow for a call an approval policy gates (EXT_APPROVALS)", () => {
    const block = buildApprovalAskBlock("effect-2", "gmail_send_email", { to: "a" }, [], {
      offerAlways: false,
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);
  });

  it("shows a gated call's full detail uncut (EXT_APPROVALS), still scrubbing run secrets", () => {
    const detail = `Call a1b2c3d4\n\n${JSON.stringify({ body: "x".repeat(10_000), to: "a", key: "s3cr3t-run-value" })}`;
    const block = buildApprovalAskBlock("effect-3", "gmail_send_email", {}, ["s3cr3t-run-value"], {
      offerAlways: false,
      detail,
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail?.length).toBeGreaterThan(10_000);
    expect(block.detail).toContain("Call a1b2c3d4");
    expect(block.detail).not.toContain("s3cr3t-run-value");
    expect(block.actions?.map((action) => action.id)).toEqual(["allow", "deny"]);
  });

  it("scrubs token-shaped values from a gated call's summary line (EXT_APPROVALS)", () => {
    // The model controls the title; a key it was never given is scrubbed by its shape.
    const shaped = "sk-test-FAKE-summary-0000000000000000";
    const block = buildApprovalAskBlock(
      "effect-4",
      "destination.write",
      { collection: "outbox", title: `${shaped} and s3cr3t-run-value` },
      ["s3cr3t-run-value"],
      { offerAlways: false, detail: "Call a1b2c3d4" },
    );
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.text).not.toContain(shaped);
    expect(block.text).not.toContain("s3cr3t-run-value");
    expect(block.text).toContain("[redacted]");
  });
});
