import { cardToBlockKit } from "@chat-adapter/slack/blocks";
import { cardToAdaptiveCard } from "@chat-adapter/teams/cards";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_ALLOW_ACTION,
  APPROVAL_DENY_ACTION,
  approvalWebDetail,
  buildApprovalDecidedCard,
  buildApprovalRequestCard,
} from "./ext-approval-card.js";
import { escapeSlackMrkdwn, escapeTeamsMarkdown, toChatCard } from "./messaging-card.js";

const SECRET = "fake-run-secret-value-for-redaction-test";

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
  callHash: "a1b2c3d4e5f60718".repeat(4),
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
    expect(text).toContain("Call a1b2c3d4");
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

  it("carries every argument, keys sorted like the call hash, and Approve only if all fits", () => {
    const card = buildApprovalRequestCard({
      ...request,
      args: { to: "ops@example.test", body: "x".repeat(20_000), cc: "boss@example.test" },
    });
    const code = card.blocks.find((block) => block.kind === "code")!;
    expect(code.text.length).toBeGreaterThan(20_000);
    expect(code.text.indexOf('"body"')).toBeLessThan(code.text.indexOf('"cc"'));
    expect(code.text.indexOf('"cc"')).toBeLessThan(code.text.indexOf('"to"'));
    expect(card.overflow).toEqual({
      notice: "{hidden} characters hidden. Open the web app to see the full call.",
      dropActions: [APPROVAL_ALLOW_ACTION],
    });
  });

  it("gives the web card the full call: reason, hash label and every argument", () => {
    const detail = approvalWebDetail({
      ...request,
      args: { to: "ops@example.test", body: "x".repeat(20_000) },
    });
    expect(detail).toContain("Sending the report");
    expect(detail).toContain("Call a1b2c3d4");
    expect(detail).toContain("x".repeat(20_000));
    expect(detail).toContain('"to": "ops@example.test"');
    expect(detail).not.toContain(SECRET);
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
    ) as unknown as { text: { text: string } };
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
      }) as Parameters<typeof cardToAdaptiveCard>[0],
    );
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("[click](https://evil.test)");
    expect(serialized).not.toContain("Crew *needs*");
    expect(card.actions).toEqual([
      expect.objectContaining({ type: "Action.Submit", data: { actionId: "a", value: "v" } }),
    ]);
  });
});

describe("cards that do not fit a chat message", () => {
  // A prompt-injected model pads the arguments so the real recipient falls past any cut.
  const padded = buildApprovalRequestCard({
    ...request,
    args: { body: "Quarterly numbers", padding: "&".repeat(40_000), to: "attacker@evil.test" },
  });
  const small = buildApprovalRequestCard(request);

  const slackText = (blocks: unknown[]) => JSON.stringify(blocks);

  it("Slack: shows what fits, says how much is hidden, and offers only Deny", () => {
    const blocks = cardToBlockKit(toChatCard("slack", padded));
    const serialized = slackText(blocks);
    expect(serialized).not.toContain("attacker@evil.test");
    expect(serialized).toMatch(
      /[\d,]+ characters hidden\. Open the web app to see the full call\./,
    );
    expect(serialized).toContain("ext_approval_deny");
    expect(serialized).not.toContain("ext_approval_allow");
    expect(serialized).toContain("Call a1b2c3d4");
    // Every section stays within Slack's limit, so the adapter never cuts silently.
    for (const block of blocks as Array<{ type: string; text?: { text: string } }>) {
      if (block.text) expect(block.text.text.length).toBeLessThanOrEqual(3_000);
    }
    expect(blocks.length).toBeLessThanOrEqual(50);
  });

  it("Teams: the same, within the Adaptive Card size", () => {
    const card = cardToAdaptiveCard(
      toChatCard("teams", padded) as Parameters<typeof cardToAdaptiveCard>[0],
    );
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("attacker@evil.test");
    expect(serialized).toMatch(/characters hidden/);
    expect(
      card.actions?.map((action) => (action as { data: { actionId: string } }).data.actionId),
    ).toEqual(["ext_approval_deny"]);
    expect(serialized.length).toBeLessThan(28_000);
  });

  it("keeps Approve and every argument when the whole call fits, split across sections", () => {
    const mid = buildApprovalRequestCard({
      ...request,
      args: { body: "y".repeat(5_000), to: "ops@example.test" },
    });
    for (const provider of ["slack", "teams"] as const) {
      const chat = toChatCard(provider, mid);
      const serialized =
        provider === "slack"
          ? slackText(cardToBlockKit(chat))
          : // Teams markdown escaping puts a backslash before "." and friends.
            JSON.stringify(
              cardToAdaptiveCard(chat as Parameters<typeof cardToAdaptiveCard>[0]),
            ).replaceAll("\\\\", "");
      expect(serialized).toContain("ops@example.test");
      expect(serialized).toContain("ext_approval_allow");
      expect(serialized).not.toContain("characters hidden");
      expect(serialized.split("y").length - 1).toBeGreaterThanOrEqual(5_000);
    }
    expect(slackText(cardToBlockKit(toChatCard("slack", small)))).toContain("ext_approval_allow");
  });
});
