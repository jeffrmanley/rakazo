import type { MessagingAction, MessagingCard } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import { SlackEmulator } from "./slack-emulator.js";
import { TeamsEmulator } from "./teams-emulator.js";

/**
 * Card buttons ride the same verified webhooks as messages: Slack interactivity posts a
 * signed form payload to /api/v1/messaging/webhook/slack, Teams posts an Adaptive Card
 * invoke with a Bot Framework JWT to /api/v1/messaging/webhook/teams. The clicker is the
 * verified sender, never anything the card carries.
 */
const context = {
  operationId: "op",
  traceId: "trace",
  spaceId: "",
  userId: "",
  signal: AbortSignal.timeout(10_000),
};

const card: MessagingCard = {
  title: "Crew needs approval",
  blocks: [{ kind: "text", text: "Action: send" }],
  actions: [
    { id: "ext_approval_allow", label: "Approve", value: "appr_1", style: "primary" },
    { id: "ext_approval_deny", label: "Deny", value: "appr_1", style: "danger" },
  ],
};

const surfaces: ChatSdkMessagingSurface[] = [];
afterEach(async () => {
  for (const surface of surfaces.splice(0)) await surface.shutdown();
});

function setup() {
  const slack = new SlackEmulator();
  const teams = new TeamsEmulator();
  const surface = new ChatSdkMessagingSurface([slack.createPlatform(), teams.createPlatform()]);
  surfaces.push(surface);
  const actions: MessagingAction[] = [];
  surface.onInbound(async () => undefined);
  surface.onAction(["ext_approval_allow", "ext_approval_deny"], async (action) => {
    actions.push(action);
  });
  return { slack, teams, surface, actions };
}

describe("Slack card buttons", () => {
  it("posts Block Kit buttons and updates the same message", async () => {
    const { slack, surface } = setup();
    expect(surface.cardProviders()).toEqual(["slack", "teams"]);
    const sent = await surface.sendCard("slack:D123:", card, context);
    expect(sent.handle).toBeTruthy();
    const posted = slack.posted.at(-1)!;
    expect(posted.channel).toBe("D123");
    expect(posted.blocks).toContainEqual(
      expect.objectContaining({
        type: "actions",
        elements: [
          expect.objectContaining({ action_id: "ext_approval_allow", value: "appr_1" }),
          expect.objectContaining({ action_id: "ext_approval_deny", value: "appr_1" }),
        ],
      }),
    );
    await surface.updateCard(
      "slack:D123:",
      sent.handle,
      { title: "Crew needs approval", blocks: [{ kind: "muted", text: "Approved by Dana" }] },
      context,
    );
    expect(slack.updated).toEqual([expect.objectContaining({ channel: "D123", ts: sent.handle })]);
    expect(JSON.stringify(slack.updated[0]!.blocks)).toContain("Approved by Dana");
    expect(JSON.stringify(slack.updated[0]!.blocks)).not.toContain("ext_approval_allow");
  });

  it("hands a signed click to the handler with the signed user id, not the button value", async () => {
    const { slack, surface, actions } = setup();
    const res = await surface.handleWebhook(
      "slack",
      slack.buildActionRequest({
        userId: "U-CLICKER",
        actionId: "ext_approval_allow",
        value: JSON.stringify({ approvalId: "appr_1", user: "U-OWNER" }),
        channelId: "D123",
        messageTs: "1700000000.000100",
        triggerId: "trigger-1",
      }),
    )!;
    expect(res.status).toBe(200);
    await surface.drainActions();
    expect(actions).toEqual([
      expect.objectContaining({
        provider: "slack",
        actionId: "ext_approval_allow",
        from: "U-CLICKER",
        messageId: "1700000000.000100",
        handle: "trigger-1",
      }),
    ]);
    await actions[0]!.respond("You can't approve this.");
    expect(slack.responses).toEqual([
      expect.objectContaining({ text: "You can't approve this.", responseType: "ephemeral" }),
    ]);
  });

  it("rejects unsigned, mis-signed and stale clicks with 401 before any handler runs", async () => {
    const { slack, surface, actions } = setup();
    const click = {
      userId: "U-OWNER",
      actionId: "ext_approval_allow",
      value: "appr_1",
      channelId: "D123",
    };
    expect(
      (await surface.handleWebhook("slack", slack.buildActionRequest(click, { sign: false }))!)
        .status,
    ).toBe(401);
    expect(
      (await surface.handleWebhook(
        "slack",
        slack.buildActionRequest(click, { signingSecret: "forged" }),
      ))!.status,
    ).toBe(401);
    expect(
      (await surface.handleWebhook(
        "slack",
        slack.buildActionRequest(click, { timestamp: Math.floor(Date.now() / 1000) - 600 }),
      ))!.status,
    ).toBe(401);
    await surface.drainActions();
    expect(actions).toEqual([]);
  });

  it("handles a retried interaction once and ignores buttons nobody registered", async () => {
    const { slack, surface, actions } = setup();
    const timestamp = Math.floor(Date.now() / 1000);
    const click = {
      userId: "U1",
      actionId: "ext_approval_deny",
      value: "appr_1",
      channelId: "D123",
      triggerId: "trigger-same",
    };
    await surface.handleWebhook("slack", slack.buildActionRequest(click, { timestamp }));
    await surface.handleWebhook("slack", slack.buildActionRequest(click, { timestamp }));
    await surface.handleWebhook(
      "slack",
      slack.buildActionRequest({ ...click, actionId: "something_else", triggerId: "t2" }),
    );
    await surface.drainActions();
    expect(actions).toHaveLength(1);
  });
});

describe("Teams card buttons", () => {
  it("posts an Adaptive Card and updates the same activity", async () => {
    const { teams, surface } = setup();
    const threadId = teams.threadId("a:emulated-personal");
    const sent = await surface.sendCard(threadId, card, context);
    const activity = teams.sent.at(-1)!;
    expect(activity.attachments?.[0]).toMatchObject({
      contentType: "application/vnd.microsoft.card.adaptive",
      content: expect.objectContaining({ type: "AdaptiveCard" }),
    });
    await surface.updateCard(
      threadId,
      sent.handle,
      { title: "Crew needs approval", blocks: [{ kind: "muted", text: "Denied by Dana" }] },
      context,
    );
    expect(teams.updated).toEqual([expect.objectContaining({ activityId: sent.handle })]);
    expect(JSON.stringify(teams.updated[0]!.attachments)).toContain("Denied by Dana");
  });

  it("hands a JWT-validated Adaptive Card invoke to the handler with the sender id", async () => {
    const { teams, surface, actions } = setup();
    const res = await surface.handleWebhook(
      "teams",
      teams.buildInvokeRequest({
        from: "29:clicker",
        actionId: "ext_approval_allow",
        value: "appr_1",
        replyToId: "sent-1",
        handle: "invoke-1",
      }),
    )!;
    expect(res.status).toBeLessThan(300);
    await surface.drainActions();
    expect(actions).toEqual([
      expect.objectContaining({
        provider: "teams",
        actionId: "ext_approval_allow",
        value: "appr_1",
        from: "29:clicker",
        messageId: "sent-1",
        handle: "invoke-1",
      }),
    ]);
  });

  it("rejects an invoke without a valid Bot Framework token and drops a repeated one", async () => {
    const { teams, surface, actions } = setup();
    const click = { from: "29:owner", actionId: "ext_approval_allow", value: "appr_1" };
    const forged = teams.buildInvokeRequest(click, teams.token({ aud: "someone-else" }));
    expect((await surface.handleWebhook("teams", forged))!.status).toBeGreaterThanOrEqual(400);
    const unsigned = teams.buildInvokeRequest(click, "");
    expect((await surface.handleWebhook("teams", unsigned))!.status).toBeGreaterThanOrEqual(400);
    await surface.drainActions();
    expect(actions).toEqual([]);
    await surface.handleWebhook("teams", teams.buildInvokeRequest({ ...click, handle: "same" }));
    await surface.handleWebhook("teams", teams.buildInvokeRequest({ ...click, handle: "same" }));
    await surface.drainActions();
    expect(actions).toHaveLength(1);
  });
});
