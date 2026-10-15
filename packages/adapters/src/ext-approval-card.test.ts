import { cardToBlockKit } from "@chat-adapter/slack/blocks";
import { cardToAdaptiveCard } from "@chat-adapter/teams/cards";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_ALLOW_ACTION,
  APPROVAL_DENY_ACTION,
  buildApprovalDecidedCard,
  buildApprovalRequestCard,
} from "./ext-approval-card.js";
import { escapeSlackMrkdwn, escapeTeamsMarkdown, toChatCard } from "./messaging-card.js";

const SECRET = "sk-live-0123456789abcdef0123456789abcdef";

const request = {
  approvalId: "appr_1",
  botName: "Crew",
  toolName: "gmail_send_email",
  riskClass: "write-external" as const,
  args: {
    to: "ops@example.test",
    body: `use key ${SECRET}`,
    api_key: "plain-but-secret-named",
  },
  reason: `Sending the report with ${SECRET} attached`,
  expiresAt: new Date("2026-10-15T12:30:00.000Z"),
  secrets: [SECRET],
};

describe("approval request card", () => {
  it("shows the action, risk, reason and arguments with Approve and Deny buttons", () => {
    const card = buildApprovalRequestCard(request);
    expect(card.title).toBe("Crew needs approval");
    const text = card.blocks.map((block) => block.text).join("\n");
    expect(text).toContain("gmail_send_email");
    expect(text).toContain("External action");
    expect(text).toContain("Sending the report");
    expect(text).toContain("ops@example.test");
    expect(text).toContain("Expires 12:30 UTC");
    expect(card.actions).toEqual([
      { id: APPROVAL_ALLOW_ACTION, label: "Approve", value: "appr_1", style: "primary" },
      { id: APPROVAL_DENY_ACTION, label: "Deny", value: "appr_1", style: "danger" },
    ]);
  });

  it("redacts known secrets and secret-named arguments", () => {
    const serialized = JSON.stringify(buildApprovalRequestCard(request));
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("plain-but-secret-named");
    expect(serialized).toContain("[redacted]");
  });

  it("bounds a very large argument payload", () => {
    const card = buildApprovalRequestCard({
      ...request,
      args: { body: "x".repeat(20_000) },
    });
    const code = card.blocks.find((block) => block.kind === "code");
    expect(code?.text.length).toBeLessThanOrEqual(2_000);
  });

  it("replaces the buttons with the outcome once decided", () => {
    const decided = buildApprovalDecidedCard(request, { outcome: "allow", byName: "Dana" });
    expect(decided.actions ?? []).toEqual([]);
    expect(decided.blocks.at(-1)?.text).toBe("Approved by Dana");
    expect(
      buildApprovalDecidedCard(request, { outcome: "deny", byName: "Dana" }).blocks.at(-1)?.text,
    ).toBe("Denied by Dana");
    expect(buildApprovalDecidedCard(request, { outcome: "expired" }).blocks.at(-1)?.text).toBe(
      "Expired without a decision",
    );
    expect(buildApprovalDecidedCard(request, { outcome: "invalid" }).blocks.at(-1)?.text).toBe(
      "No longer valid",
    );
    expect(JSON.stringify(decided)).not.toContain(SECRET);
  });
});

describe("platform escaping", () => {
  const hostile = "<!channel> *bold* <https://evil.test|Approve here> & [click](https://evil.test)";

  it("escapes Slack mrkdwn control characters so arguments cannot mention, link or format", () => {
    expect(escapeSlackMrkdwn("<!channel> & <@U1>")).toBe("&lt;!channel&gt; &amp; &lt;@U1&gt;");
    const blocks = cardToBlockKit(
      toChatCard("slack", {
        title: "Crew needs approval",
        blocks: [
          { kind: "text", text: hostile },
          { kind: "code", text: `{"body": "${hostile} \`\`\` done"}` },
        ],
        actions: [{ id: "a", label: "Approve", value: "v" }],
      }),
    );
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain("<!channel>");
    expect(serialized).not.toContain("<https://evil.test|");
    expect(serialized).toContain("&lt;!channel&gt;");
    // The argument block stays one code block: an embedded fence cannot close it.
    const code = blocks.find(
      (block) => block.type === "section" && JSON.stringify(block).includes("done"),
    ) as { text: { text: string } };
    expect(code.text.text.startsWith("```")).toBe(true);
    expect(code.text.text.match(/```/g)).toHaveLength(2);
    expect(blocks).toContainEqual(
      expect.objectContaining({
        type: "actions",
        elements: [expect.objectContaining({ action_id: "a", value: "v" })],
      }),
    );
  });

  it("escapes Teams markdown so arguments cannot link or format", () => {
    expect(escapeTeamsMarkdown("[x](https://e.test) *b* _i_")).toBe(
      "\\[x\\]\\(https://e\\.test\\) \\*b\\* \\_i\\_",
    );
    const card = cardToAdaptiveCard(
      toChatCard("teams", {
        title: "Crew *needs* approval",
        blocks: [{ kind: "code", text: hostile }],
        actions: [{ id: "a", label: "Approve", value: "v", style: "primary" }],
      }),
    );
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("[click](https://evil.test)");
    expect(serialized).not.toContain("Crew *needs*");
    expect(card.actions).toEqual([
      expect.objectContaining({ type: "Action.Submit", data: { actionId: "a", value: "v" } }),
    ]);
  });
});
