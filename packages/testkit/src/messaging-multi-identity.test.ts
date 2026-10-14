import { randomInt } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { messagingDeliverJob } from "@rakazo/adapter-kit";
import {
  ChatSdkMessagingSurface,
  createEmulatedSendbluePlatform,
  MessagingTeamChatEmulator,
  SendBlueEmulator,
} from "@rakazo/adapters";
import { formatMessagingLinkCode, issueMessagingLinkCode } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeMessaging = hasDb ? describe.sequential : describe.skip;

type App = { request: (input: string | Request, init?: RequestInit) => Promise<Response> };

/**
 * One agent reachable from two chat apps (iMessage through the sendblue
 * emulator, a second platform through the team-chat emulator mounted as a
 * personal line). Replies follow the app a message came from; proactive
 * sends go to the home the owner picks; unlinking one app keeps the other.
 */
describeMessaging("one agent linked in several chat apps", () => {
  let app: App;
  let stop: () => Promise<void>;
  let prisma: any;
  let jobs: { enqueue: (job: unknown) => Promise<unknown> };
  const sendblue = new SendBlueEmulator();
  const sendbluePlatform = createEmulatedSendbluePlatform(sendblue);
  const second = new MessagingTeamChatEmulator({ provider: "chatapp-emulator" });
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-messaging-multi-"));
  const uniqueNumber = () => `+1555${String(randomInt(10_000_000)).padStart(7, "0")}`;
  const phone = uniqueNumber();
  const secondAddress = `U-${randomInt(1_000_000_000)}`;
  const secondDmThread = `chatapp-emulator:dm:${secondAddress}`;
  const findIdentity = (provider: string, address: string) =>
    prisma.messagingIdentity.findUnique({ where: { provider_address: { provider, address } } });
  let owner: { userId: string; spaceId: string; botId: string };

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      messagingOpenSignup: true,
      messaging: new ChatSdkMessagingSurface([sendbluePlatform, second.createPlatform()]),
    });
    app = handles.app;
    stop = handles.stop;
    prisma = handles.prisma;
    jobs = handles.jobs;
  });

  afterAll(async () => {
    await stop?.();
  });

  it("provisions the agent from the first chat app and links a second one by code", async () => {
    // "remember …" completes in one scripted step, so each exchange is one run.
    const first = await app.request(
      sendblue.buildInboundRequest({ fromNumber: phone, content: "remember I like tea" }),
    );
    expect(first.status).toBe(200);
    const identity = await waitForDatabase(() => findIdentity("sendblue", phone));
    owner = { userId: identity.userId, spaceId: identity.spaceId, botId: identity.botId };
    // The first reply lands on the phone before the second app joins.
    await waitForDatabase(async () => sendblue.sent.find((message) => message.to === phone));

    const issued = await issueMessagingLinkCode(prisma, owner);
    const linkResponse = await app.request(
      second.buildInboundRequest({
        isDirect: true,
        from: secondAddress,
        threadId: secondDmThread,
        content: formatMessagingLinkCode(issued.code),
      }),
    );
    expect(linkResponse.status).toBe(200);
    const linked = await waitForDatabase(() => findIdentity("chatapp-emulator", secondAddress));
    expect(linked.userId).toBe(owner.userId);
    expect(linked.botId).toBe(owner.botId);
    // The confirmation answers on the app the code came from.
    await waitForDatabase(async () =>
      second.sent.find(
        (post) => post.threadId === secondDmThread && post.body.startsWith("Linked"),
      ),
    );
    expect(await prisma.messagingIdentity.count({ where: { botId: owner.botId } })).toBe(2);
  });

  it("replies on the chat app the message came from", async () => {
    sendblue.sent.length = 0;
    second.resetWitnesses();
    const response = await app.request(
      second.buildInboundRequest({
        isDirect: true,
        from: secondAddress,
        threadId: secondDmThread,
        content: "remember I prefer the second app",
      }),
    );
    expect(response.status).toBe(200);
    const secondIdentity = await findIdentity("chatapp-emulator", secondAddress);
    // The run records which linked app it arrived through.
    const run = await waitForDatabase(async () =>
      prisma.run.findFirst({
        where: {
          botId: owner.botId,
          trigger: "messaging",
          status: "completed",
          messagingIdentityId: secondIdentity.id,
        },
      }),
    );
    expect(run.messagingIdentityId).not.toBe((await findIdentity("sendblue", phone)).id);
    await waitForDatabase(async () =>
      second.sent.find(
        (post) => post.threadId === secondDmThread && !post.body.startsWith("Linked"),
      ),
    );
    expect(sendblue.sent.filter((message) => message.to === phone)).toHaveLength(0);
  });

  it("sends proactive messages to the home identity the owner picks", async () => {
    const phoneIdentity = await findIdentity("sendblue", phone);
    const secondIdentity = await findIdentity("chatapp-emulator", secondAddress);
    const bot = await prisma.bot.findUnique({ where: { id: owner.botId } });
    // The first link is the default home.
    expect(bot.homeMessagingIdentityId ?? phoneIdentity.id).toBe(phoneIdentity.id);
    await prisma.bot.update({
      where: { id: owner.botId },
      data: { homeMessagingIdentityId: secondIdentity.id },
    });

    // A delegated bot_message reply has no originating chat app.
    const thread = await prisma.thread.findFirst({ where: { botId: owner.botId } });
    const task = await prisma.task.create({
      data: {
        spaceId: owner.spaceId,
        botId: owner.botId,
        threadId: thread.id,
        userId: owner.userId,
        prompt: "delegated",
        status: "completed",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: owner.spaceId,
        botId: owner.botId,
        threadId: thread.id,
        taskId: task.id,
        userId: owner.userId,
        status: "completed",
        trigger: "bot_message",
        completedAt: new Date(),
      },
    });
    await prisma.message.create({
      data: {
        threadId: thread.id,
        seq: 10_000,
        role: "bot",
        botId: owner.botId,
        runId: run.id,
        blocks: [{ kind: "text", text: "Proactive note from your agent" }],
      },
    });
    sendblue.sent.length = 0;
    second.resetWitnesses();
    await jobs.enqueue(messagingDeliverJob(run.id));
    await waitForDatabase(async () =>
      second.sent.find(
        (post) =>
          post.threadId === secondDmThread && post.body === "Proactive note from your agent",
      ),
    );
    expect(sendblue.sent.filter((message) => message.to === phone)).toHaveLength(0);
  });

  it("keeps the other chat app working after one is unlinked", async () => {
    const secondIdentity = await findIdentity("chatapp-emulator", secondAddress);
    // Unlink the home, as the web UI would; the bot falls back to its remaining link.
    await prisma.messagingIdentity.delete({ where: { id: secondIdentity.id } });
    await prisma.bot.updateMany({
      where: { homeMessagingIdentityId: secondIdentity.id },
      data: { homeMessagingIdentityId: null },
    });
    sendblue.sent.length = 0;
    second.resetWitnesses();
    const response = await app.request(
      sendblue.buildInboundRequest({ fromNumber: phone, content: "remember I am still here" }),
    );
    expect(response.status).toBe(200);
    await waitForDatabase(async () => sendblue.sent.find((message) => message.to === phone));
    expect(second.sent).toHaveLength(0);
    expect(await prisma.messagingIdentity.count({ where: { botId: owner.botId } })).toBe(1);
  });
});

async function waitForDatabase<T>(pred: () => Promise<T | false | null | undefined>): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    const value = await pred();
    if (value) return value as T;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for database state");
}
