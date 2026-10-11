import { randomInt } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatSdkMessagingSurface, TeamsEmulator } from "@rakazo/adapters";
import { provisionMessagingIdentity } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeTeams = hasDb ? describe.sequential : describe.skip;

type App = { request: (input: string | Request, init?: RequestInit) => Promise<Response> };

/**
 * Teams group chats and channels on the team-chat path: the real pinned
 * adapter verifies locally signed Bot Framework tokens, inbound rooms reach
 * the Teams-keyed TeamChatBridge for TEAM_CHAT_BOT_ID, and replies are
 * recorded instead of posted to Bot Connector.
 */
describeTeams("Teams group chats and channels", () => {
  let app: App;
  let stop: () => Promise<void>;
  let prisma: any;
  const teams = new TeamsEmulator();
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-teams-rooms-"));
  const stamp = randomInt(1_000_000_000);
  const groupId = `19:group-${stamp}@thread.v2`;
  const channelId = `19:channel-${stamp}@thread.tacv2`;
  let bot: { id: string; spaceId: string; userId: string };

  beforeAll(async () => {
    const { createDb } = await import("@rakazo/db");
    const { createApp } = await import("../../../apps/api/src/app.ts");
    // The team bot is any existing bot; seed one through the personal line.
    const seedDb = createDb(process.env.DATABASE_URL!);
    const seeded = await provisionMessagingIdentity(
      seedDb.prisma,
      { provider: "seed-teams", address: `seed-${stamp}` },
      { signupsEnabled: "true", signupAllowlist: "" },
    );
    await seedDb.prisma.messagingIdentity.delete({ where: { id: seeded.identityId } });
    await seedDb.prisma.$disconnect();
    await seedDb.pool.end();
    bot = { id: seeded.botId, spaceId: seeded.spaceId, userId: seeded.userId };

    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      teamChatBotId: bot.id,
      messaging: new ChatSdkMessagingSurface([teams.createPlatform()]),
    });
    app = handles.app;
    stop = handles.stop;
    prisma = handles.prisma;
  });

  afterAll(async () => {
    await stop?.();
  });

  const externalMessage = (handle: string) =>
    prisma.externalMessage.findFirst({
      where: { providerEventId: handle, externalConversation: { provider: "teams" } },
      include: { externalConversation: true },
    });

  it("answers an @mention in a group chat inside that chat", async () => {
    const handle = `mention-${stamp}`;
    const response = await app.request(
      teams.buildInboundRequest({
        conversationType: "groupChat",
        conversationId: groupId,
        text: "remember the launch is Friday",
        mentionBot: true,
        handle,
      }),
    );
    expect(response.status).toBeLessThan(300);
    const delivered = await waitForDatabase(async () => {
      const row = await externalMessage(handle);
      return row?.status === "delivered" ? row : null;
    });
    expect(delivered.kind).toBe("mention");
    expect(delivered.externalConversation).toMatchObject({
      provider: "teams",
      workspaceId: teams.tenantId,
      externalKey: groupId,
      botId: bot.id,
    });
    expect(teams.sent).toHaveLength(1);
    expect(teams.sent[0]).toMatchObject({ conversationId: groupId, textFormat: "markdown" });
    expect(teams.sent[0]!.text.length).toBeGreaterThan(0);
  });

  it("replies inside the channel thread the mention came from", async () => {
    teams.resetWitnesses();
    const handle = `thread-${stamp}`;
    const threadId = `${channelId};messageid=1700000000555`;
    const response = await app.request(
      teams.buildInboundRequest({
        conversationType: "channel",
        conversationId: threadId,
        text: "remember the thread question",
        mentionBot: true,
        handle,
      }),
    );
    expect(response.status).toBeLessThan(300);
    const delivered = await waitForDatabase(async () => {
      const row = await externalMessage(handle);
      return row?.status === "delivered" ? row : null;
    });
    // The channel is one conversation; each thread is addressed by its root.
    expect(delivered.externalConversation.externalKey).toBe(channelId);
    expect(delivered.replyThreadId).toBe("1700000000555");
    expect(teams.sent).toHaveLength(1);
    expect(teams.sent[0]!.conversationId).toBe(threadId);
  });

  it("ignores an un-mentioned message while listening is off", async () => {
    teams.resetWitnesses();
    const handle = `ambient-${stamp}`;
    const response = await app.request(
      teams.buildInboundRequest({
        conversationType: "groupChat",
        conversationId: groupId,
        text: "just chatting among ourselves",
        handle,
      }),
    );
    expect(response.status).toBeLessThan(300);
    const ignored = await waitForDatabase(async () => {
      const row = await externalMessage(handle);
      return row?.status === "ignored" ? row : null;
    });
    expect(ignored.kind).toBe("ambient");
    expect(teams.sent).toHaveLength(0);
  });

  it("lets only linked senders wake message routines from a shared room", async () => {
    teams.resetWitnesses();
    const routine = await prisma.routine.create({
      data: {
        spaceId: bot.spaceId,
        botId: bot.id,
        userId: bot.userId,
        name: "Teams triage",
        prompt: "remember to triage this message",
        crons: [],
        active: true,
        messageProvider: "teams",
      },
    });

    const strangerHandle = `stranger-${stamp}`;
    const stranger = await app.request(
      teams.buildInboundRequest({
        conversationType: "groupChat",
        conversationId: groupId,
        from: "29:stranger",
        text: "remember to run the triage routine",
        mentionBot: true,
        handle: strangerHandle,
      }),
    );
    expect(stranger.status).toBeLessThan(300);
    await waitForDatabase(async () => {
      const row = await externalMessage(strangerHandle);
      return row?.status === "delivered" ? row : null;
    });
    // The team bot answered as itself; no routine wake (a webhook-trigger run) started.
    expect(await prisma.run.count({ where: { botId: bot.id, trigger: "webhook" } })).toBe(0);
    expect(routine.active).toBe(true);

    // A member whose Teams account is linked to the owner can wake it.
    await prisma.messagingIdentity.create({
      data: {
        provider: "teams",
        address: `29:member-${stamp}`,
        userId: bot.userId,
        spaceId: bot.spaceId,
        botId: bot.id,
      },
    });
    const memberHandle = `member-${stamp}`;
    const member = await app.request(
      teams.buildInboundRequest({
        conversationType: "groupChat",
        conversationId: groupId,
        from: `29:member-${stamp}`,
        text: "remember to run the triage routine",
        mentionBot: true,
        handle: memberHandle,
      }),
    );
    expect(member.status).toBeLessThan(300);
    const routed = await waitForDatabase(async () => {
      const row = await externalMessage(memberHandle);
      return row?.status === "ignored" ? row : null;
    });
    // Routine routing owned the message: the wake run exists and no team-chat
    // agent run was started for it.
    expect(routed.engagementReason).toBe("message_routine_wake");
    expect(routed.runId).toBeNull();
    expect(await prisma.run.count({ where: { botId: bot.id, trigger: "webhook" } })).toBe(1);
  });
});

async function waitForDatabase<T>(pred: () => Promise<T | false | null | undefined>): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const value = await pred();
    if (value) return value as T;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for database state");
}
