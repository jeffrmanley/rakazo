import { randomInt, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  ProcessEvent,
} from "@rakazo/adapter-kit";
import {
  ChatSdkMessagingSurface,
  ComposioEmulator,
  FakeSandboxProvider,
  MessagingTeamChatEmulator,
  SlackEmulator,
  TeamsEmulator,
} from "@rakazo/adapters";
import { loadExtEnv } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  AuditWriteError,
  createAuditWriter,
  getEmergencyStop,
  installAuditWriter,
  provisionMessagingIdentity,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { startModelEmulator } from "./model-emulator.js";

type App = { request: (input: string | Request, init?: RequestInit) => Promise<Response> };
type Handles = Awaited<ReturnType<typeof createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeStop = hasDb ? describe.sequential : describe.skip;
const origin = "http://127.0.0.1:5173";
const extOn = { ...loadExtEnv({}), auditLog: true, emergencyStop: true };
const STOP = "/api/v1/control/stop";
const RESUME = "/api/v1/control/resume";
const STATE = "/api/v1/control/state";

describeStop("fork extension: emergency stop through the API", () => {
  const stamp = `${Date.now()}-${randomInt(1_000_000)}`;
  let handles: Handles;
  let app: App;
  let prisma: Handles["prisma"];
  let previousOwner: string | null = null;
  const users: Record<
    "ownerA" | "member" | "ownerB" | "admin",
    { cookie: string; userId: string; spaceId: string }
  > = {} as never;
  let alice: string;
  let bob: string;

  const boot = async (ext = extOn) => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir: mkdtempSync(path.join(tmpdir(), "rakazo-stop-")),
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      composio: new ComposioEmulator(),
      ext,
    });
    app = handles.app;
    prisma = handles.prisma;
  };

  beforeAll(async () => {
    await boot();
    for (const [key, name] of [
      ["ownerA", "Ada Owner"],
      ["member", "Max Member"],
      ["ownerB", "Bea Owner"],
      ["admin", "Ira Admin"],
    ] as const) {
      const email = `stop-${key.toLowerCase()}-${stamp}@rakazo.test`;
      const cookie = await signup(app, email, name);
      const user = await prisma.user.findFirstOrThrow({ where: { email }, select: { id: true } });
      const membership = await prisma.spaceMember.findFirstOrThrow({
        where: { userId: user.id },
        select: { spaceId: true },
      });
      users[key] = { cookie, userId: user.id, spaceId: membership.spaceId };
    }
    // Max is a plain member of Ada's space (a database trigger adds the space membership).
    const spaceA = await prisma.space.findUniqueOrThrow({
      where: { id: users.ownerA.spaceId },
      select: { organizationId: true },
    });
    await prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: spaceA.organizationId,
        userId: users.member.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    const settings = await prisma.deploymentSettings.findUniqueOrThrow({
      where: { id: "default" },
    });
    previousOwner = settings.ownerUserId;
    await prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: users.admin.userId },
    });
    alice = await createBot(handles, users.ownerA.cookie, "Alice");
    bob = await createBot(handles, users.ownerB.cookie, "Bob");
  });

  afterAll(async () => {
    await prisma?.extControlStop.updateMany({
      where: { resumedAt: null, stoppedBy: { in: Object.values(users).map((u) => u.userId) } },
      data: { resumedAt: new Date(), resumedBy: "test-cleanup" },
    });
    await prisma?.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: previousOwner },
    });
    await handles?.stop();
  });

  const activeStops = () =>
    prisma.extControlStop.findMany({
      where: {
        resumedAt: null,
        stoppedBy: { in: Object.values(users).map((user) => user.userId) },
      },
    });

  it("allows only owners: members, other spaces and non-admins are refused", async () => {
    // Plain member of space A, selecting space A.
    const asMember = await post(
      app,
      users.member.cookie,
      STOP,
      { scope: "bot", botId: alice, reason: "x" },
      {
        "x-rakazo-space-id": users.ownerA.spaceId,
      },
    );
    expect(asMember.status).toBe(403);
    expect(
      (
        await post(
          app,
          users.member.cookie,
          STOP,
          { scope: "space", reason: "x" },
          {
            "x-rakazo-space-id": users.ownerA.spaceId,
          },
        )
      ).status,
    ).toBe(403);
    // Space B's owner cannot reach space A's bot: not found, like a missing bot.
    const foreign = await post(app, users.ownerB.cookie, STOP, {
      scope: "bot",
      botId: alice,
      reason: "x",
    });
    expect(foreign.status).toBe(404);
    expect(
      (await post(app, users.ownerB.cookie, RESUME, { scope: "bot", botId: alice, reason: "x" }))
        .status,
    ).toBe(404);
    // Only the deployment owner may stop everything.
    expect(
      (await post(app, users.ownerA.cookie, STOP, { scope: "global", reason: "x" })).status,
    ).toBe(403);
    expect((await post(app, "", STOP, { scope: "space", reason: "x" })).status).toBe(401);
    expect(await activeStops()).toEqual([]);
  });

  it("ignores a spaceId in the body or query and keeps each space's state private", async () => {
    const res = await post(app, users.ownerB.cookie, `${STOP}?spaceId=${users.ownerA.spaceId}`, {
      scope: "space",
      reason: "spoof",
      spaceId: users.ownerA.spaceId,
    });
    expect(res.status).toBe(200);
    const [row] = await activeStops();
    expect(row).toMatchObject({ scope: "space", spaceId: users.ownerB.spaceId });
    const stateA = await stateOf(app, users.ownerA.cookie);
    expect(stateA.stops).toEqual([]);
    const stateB = await stateOf(app, users.ownerB.cookie, `?spaceId=${users.ownerA.spaceId}`);
    expect(stateB.stops).toEqual([
      expect.objectContaining({
        scope: "space",
        reason: "spoof",
        stoppedBy: expect.objectContaining({ name: "Bea Owner" }),
      }),
    ]);
    // A's owner cannot resume B's space by naming it either.
    await post(app, users.ownerA.cookie, RESUME, {
      scope: "space",
      reason: "spoof",
      spaceId: users.ownerB.spaceId,
    });
    expect(await activeStops()).toHaveLength(1);
    expect(
      (await post(app, users.ownerB.cookie, RESUME, { scope: "space", reason: "done" })).status,
    ).toBe(200);
    expect(await activeStops()).toEqual([]);
  });

  it("stops a bot: queued runs are cancelled, new runs never execute, routines hold, events are audited", async () => {
    const queued = await queueRun(prisma, alice);
    const res = await post(app, users.ownerA.cookie, STOP, {
      scope: "bot",
      botId: alice,
      reason: "runaway loop",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stop: { scope: string; botId: string };
      error_id?: string;
    };
    expect(body.stop).toMatchObject({ scope: "bot", botId: alice });
    expect(body.error_id).toBeUndefined();
    await expect(runStatus(prisma, queued)).resolves.toBe("cancelled");
    expect(await prisma.event.count({ where: { runId: queued, type: "run.cancelled" } })).toBe(1);
    // Bob in space B keeps running.
    await expect(
      getEmergencyStop()!.check({ spaceId: users.ownerB.spaceId, botId: bob }),
    ).resolves.toBeNull();

    // A message from the web still lands, but its run is cancelled before it starts.
    const sent = await rpc<{ runId: string }>(app, users.ownerA.cookie, "threads/send", {
      botId: alice,
      text: "remember this while paused",
    });
    await expect.poll(() => runStatus(prisma, sent.runId), { timeout: 5_000 }).toBe("cancelled");
    expect(await prisma.message.count({ where: { runId: sent.runId, role: "bot" } })).toBe(0);

    // A due routine does not start; its next occurrence is scheduled instead.
    const thread = await prisma.thread.findUniqueOrThrow({ where: { botId: alice } });
    const dueAt = new Date(Date.now() - 1_000);
    const routine = await prisma.routine.create({
      data: {
        spaceId: users.ownerA.spaceId,
        botId: alice,
        userId: users.ownerA.userId,
        threadId: thread.id,
        name: "Hourly",
        prompt: "remember the hourly check",
        crons: ["0 * * * *"],
        active: true,
        nextRunAt: dueAt,
      },
    });
    await handles.executor.wakeRoutine(routine.id, dueAt.toISOString());
    expect(await prisma.run.count({ where: { routineId: routine.id } })).toBe(0);
    const held = await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(held.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    await prisma.routine.delete({ where: { id: routine.id } });

    const audit = await prisma.extAuditEvent.findMany({
      where: { spaceId: users.ownerA.spaceId, kind: "control.stop" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: "human",
      actorId: users.ownerA.userId,
      botId: alice,
    });
    expect(audit[0]!.summary).toContain("runaway loop");
    expect(audit[0]!.detail).toMatchObject({ scope: "bot", botId: alice, cancelledRuns: 1 });
  });

  it("stays stopped across a restart until resumed, then runs again", async () => {
    await handles.stop();
    await boot();
    const state = await stateOf(app, users.ownerA.cookie);
    expect(state).toMatchObject({ canControl: true, canControlGlobal: false });
    expect(state.stops).toEqual([expect.objectContaining({ scope: "bot", botId: alice })]);
    const sent = await rpc<{ runId: string }>(app, users.ownerA.cookie, "threads/send", {
      botId: alice,
      text: "remember this after the restart",
    });
    await expect.poll(() => runStatus(prisma, sent.runId), { timeout: 5_000 }).toBe("cancelled");

    const resumed = await post(app, users.ownerA.cookie, RESUME, {
      scope: "bot",
      botId: alice,
      reason: "fixed",
    });
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({ resumed: 1 });
    const audit = await prisma.extAuditEvent.findFirstOrThrow({
      where: { spaceId: users.ownerA.spaceId, kind: "control.resume" },
    });
    expect(audit).toMatchObject({ actorType: "human", actorId: users.ownerA.userId, botId: alice });
    const after = await rpc<{ runId: string }>(app, users.ownerA.cookie, "threads/send", {
      botId: alice,
      text: "remember this after the resume",
    });
    await expect.poll(() => runStatus(prisma, after.runId), { timeout: 15_000 }).toBe("completed");
    // History is kept.
    expect(
      await prisma.extControlStop.count({ where: { botId: alice, resumedAt: { not: null } } }),
    ).toBe(1);
  });

  it("holds the brake when the stop's audit insert fails, but refuses an unaudited resume", async () => {
    const failing = () => Promise.reject(new AuditWriteError(new Error("audit storage down")));
    installAuditWriter({ record: failing, recordInTransaction: failing });
    try {
      const stopped = await post(app, users.ownerA.cookie, STOP, {
        scope: "space",
        reason: "fire",
      });
      expect(stopped.status).toBe(200);
      const body = (await stopped.json()) as { error_id?: string };
      expect(body.error_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await activeStops()).toEqual([
        expect.objectContaining({ scope: "space", spaceId: users.ownerA.spaceId }),
      ]);

      const resumed = await post(app, users.ownerA.cookie, RESUME, { scope: "space", reason: "x" });
      expect(resumed.status).toBe(500);
      const failure = (await resumed.json()) as { error: string; error_id: string };
      expect(failure.error).toBe("Internal error");
      expect(failure.error_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.stringify(failure)).not.toContain("audit storage down");
      expect(await activeStops()).toHaveLength(1);
    } finally {
      installAuditWriter(createAuditWriter(prisma));
    }
    expect(
      (await post(app, users.ownerA.cookie, RESUME, { scope: "space", reason: "x" })).status,
    ).toBe(200);
    expect(await activeStops()).toEqual([]);
  });

  it("lets the deployment owner stop and resume everything", async () => {
    const res = await post(app, users.admin.cookie, STOP, { scope: "global", reason: "incident" });
    expect(res.status).toBe(200);
    await expect(
      getEmergencyStop()!.check({ spaceId: users.ownerB.spaceId, botId: bob }),
    ).resolves.toMatchObject({ scope: "global" });
    // Every space sees the global stop; only the admin may lift it.
    expect((await stateOf(app, users.ownerB.cookie)).stops).toEqual([
      expect.objectContaining({ scope: "global" }),
    ]);
    expect(
      (await post(app, users.ownerB.cookie, RESUME, { scope: "global", reason: "x" })).status,
    ).toBe(403);
    expect(
      (await post(app, users.admin.cookie, RESUME, { scope: "global", reason: "over" })).status,
    ).toBe(200);
    expect(await activeStops()).toEqual([]);
  });

  it("changes nothing when EXT_EMERGENCY_STOP is off", async () => {
    await handles.stop();
    await boot({ ...loadExtEnv({}) });
    expect(getEmergencyStop()).toBeNull();
    for (const [method, url] of [
      ["POST", STOP],
      ["POST", RESUME],
      ["GET", STATE],
    ] as const) {
      const res = await app.request(url, {
        method,
        headers: { cookie: users.ownerA.cookie, origin, "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ scope: "space", reason: "x" }) } : {}),
      });
      expect(res.status).toBe(404);
    }
  });
});

/** Shell commands named "slow-tool" take a while, so a stop can land mid-call. */
class SlowFakeSandbox extends FakeSandboxProvider {
  onSlowStart: (() => void) | undefined;

  override async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (request.argv.join(" ").includes("slow-tool")) {
      this.onSlowStart?.();
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    }
    yield* super.execute(computer, request, context);
  }
}

describeStop("fork extension: emergency stop halts live runs", () => {
  const fixtureKey = "stop-fixture-key";
  let handles: Handles;
  let cookie: string;
  let botId: string;
  let modelOpened: () => void = () => undefined;
  let modelClosed: () => void = () => undefined;
  const sandbox = new SlowFakeSandbox();
  let model: Awaited<ReturnType<typeof startModelEmulator>>;

  beforeAll(async () => {
    const respond = (request: { messages: Array<{ role: string; content?: unknown }> }) => {
      const lastUser = request.messages.findLast((message) => message.role === "user");
      const text = JSON.stringify(lastUser?.content ?? "");
      const lastMessage = request.messages.at(-1);
      if (lastMessage?.role === "tool") return { type: "text" as const, text: "after the tool" };
      if (text.includes("HOLD-MODEL")) {
        return {
          type: "hold" as const,
          text: "thinking",
          onOpen: () => modelOpened(),
          onClose: () => modelClosed(),
        };
      }
      if (text.includes("SLOW-TOOL")) {
        return {
          type: "tool" as const,
          id: "slow-call",
          name: "shell",
          arguments: { command: "slow-tool" },
        };
      }
      return { type: "text" as const, text: "ok" };
    };
    model = await startModelEmulator({
      apiKey: fixtureKey,
      steps: Array.from({ length: 20 }, () => ({ expect: () => undefined, response: respond })),
    });
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: origin,
      webOrigin: origin,
      dataDir: mkdtempSync(path.join(tmpdir(), "rakazo-stop-live-")),
      sandboxProvider: "fake",
      sandbox,
      agentRuntime: "pi",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
      encryptionKey: "stop-fixture-encryption-key-0123456789",
      ext: extOn,
    });
    cookie = await signup(handles.app, `stop-live-${randomUUID()}@rakazo.test`, "Liv Owner");
    await rpc(handles.app, cookie, "models/connect", {
      provider: model.model.provider,
      modelId: model.model.id,
      baseUrl: model.baseUrl,
      apiKey: fixtureKey,
      contextWindow: 160_000,
      maxTokens: 4096,
    });
    botId = await createBot(handles, cookie, "Runner");
    await rpc(handles.app, cookie, "bots/update", {
      botId,
      modelProvider: model.model.provider,
      modelId: model.model.id,
    });
  });

  afterAll(async () => {
    await handles?.prisma.extControlStop.updateMany({
      where: { botId, resumedAt: null },
      data: { resumedAt: new Date(), resumedBy: "test-cleanup" },
    });
    await handles?.stop();
    await model?.close();
  });

  it("aborts an in-flight model call and cancels the run within 5 seconds", async () => {
    const opened = new Promise<void>((resolve) => {
      modelOpened = resolve;
    });
    const closed = new Promise<number>((resolve) => {
      modelClosed = () => resolve(Date.now());
    });
    const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
      botId,
      text: "HOLD-MODEL and think for a long time",
    });
    await opened;
    const requestsBefore = model.requests.length;
    const stoppedAt = Date.now();
    const res = await post(handles.app, cookie, STOP, {
      scope: "bot",
      botId,
      reason: "model runaway",
    });
    expect(res.status).toBe(200);
    await expect
      .poll(() => runStatus(handles.prisma, sent.runId), { timeout: 5_000, interval: 50 })
      .toBe("cancelled");
    const closedAt = await closed;
    expect(closedAt - stoppedAt).toBeLessThan(5_000);
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);
    expect(model.requests.length).toBe(requestsBefore);
    await post(handles.app, cookie, RESUME, { scope: "bot", botId, reason: "ok" });
  });

  it("lets a tool call already running finish, records it, and runs nothing new", async () => {
    const started = new Promise<void>((resolve) => {
      sandbox.onSlowStart = resolve;
    });
    const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
      botId,
      text: "SLOW-TOOL please",
    });
    await started;
    const requestsBefore = model.requests.length;
    const res = await post(handles.app, cookie, STOP, { scope: "bot", botId, reason: "mid tool" });
    expect(res.status).toBe(200);
    await expect
      .poll(() => runStatus(handles.prisma, sent.runId), { timeout: 8_000, interval: 50 })
      .toBe("cancelled");
    const toolEvents = await handles.prisma.extAuditEvent.findMany({
      where: { runId: sent.runId, kind: { in: ["tool.call", "tool.result"] } },
      orderBy: { seq: "asc" },
    });
    expect(toolEvents.map((event) => event.kind)).toEqual(["tool.call", "tool.result"]);
    expect(toolEvents[1]!.detail).toMatchObject({ name: "shell", outcome: "succeeded" });
    // No model call after the tool: the run halted before going back to the model.
    expect(model.requests.length).toBe(requestsBefore);
    // The bot's computer is paused (checkpointed and stopped), not destroyed.
    const bot = await handles.prisma.bot.findUniqueOrThrow({
      where: { id: botId },
      select: { computerId: true },
    });
    await expect
      .poll(
        async () =>
          (
            await handles.prisma.computer.findUnique({
              where: { id: bot.computerId! },
              select: { state: true },
            })
          )?.state,
        { timeout: 15_000, interval: 100 },
      )
      .toBe("suspended");
  });
});

describeStop("fork extension: emergency stop from Slack and Teams", () => {
  const stamp = randomInt(1_000_000_000);
  const slack = new MessagingTeamChatEmulator({ provider: "slack" });
  const teams = new TeamsEmulator();
  const groupId = `19:stop-group-${stamp}@thread.v2`;
  let handles: Handles;
  let app: App;
  let prisma: PrismaClient;
  let owner: { userId: string; spaceId: string; botId: string };
  const ownerSlack = `U-OWNER-${stamp}`;
  const memberSlack = `U-MEMBER-${stamp}`;
  const ownerTeams = `29:owner-${stamp}`;

  const boot = async (ext = extOn) => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir: mkdtempSync(path.join(tmpdir(), "rakazo-stop-chat-")),
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      teamChatBotId: owner.botId,
      messaging: new ChatSdkMessagingSurface([slack.createPlatform(), teams.createPlatform()]),
      ext,
    });
    app = handles.app;
    prisma = handles.prisma;
  };

  beforeAll(async () => {
    const { createDb } = await import("@rakazo/db");
    const seed = createDb(process.env.DATABASE_URL!);
    const policy = { signupsEnabled: "true", signupAllowlist: "" };
    const seeded = await provisionMessagingIdentity(
      seed.prisma,
      { provider: "seed-stop", address: `owner-${stamp}`, displayName: "Dana Owner" },
      policy,
    );
    owner = { userId: seeded.userId, spaceId: seeded.spaceId, botId: seeded.botId };
    await seed.prisma.bot.update({ where: { id: owner.botId }, data: { name: "Crew" } });
    const plain = await provisionMessagingIdentity(
      seed.prisma,
      { provider: "seed-stop", address: `member-${stamp}`, displayName: "Plain Member" },
      policy,
    );
    const space = await seed.prisma.space.findUniqueOrThrow({
      where: { id: owner.spaceId },
      select: { organizationId: true },
    });
    await seed.prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: space.organizationId,
        userId: plain.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await seed.prisma.messagingIdentity.createMany({
      data: [
        { provider: "slack", address: ownerSlack, ...owner },
        { provider: "teams", address: ownerTeams, ...owner },
        {
          provider: "slack",
          address: memberSlack,
          userId: plain.userId,
          spaceId: owner.spaceId,
          botId: owner.botId,
        },
      ],
    });
    await seed.prisma.$disconnect();
    await seed.pool.end();
    await boot();
  });

  afterAll(async () => {
    await prisma?.extControlStop.updateMany({
      where: { spaceId: owner.spaceId, resumedAt: null },
      data: { resumedAt: new Date(), resumedBy: "test-cleanup" },
    });
    await handles?.stop();
  });

  const stops = () =>
    prisma.extControlStop.findMany({ where: { spaceId: owner.spaceId, resumedAt: null } });
  const runCount = () => prisma.run.count({ where: { botId: owner.botId } });
  const slackSays = (content: string, extra: Record<string, unknown> = {}) =>
    app.request(
      slack.buildInboundRequest({
        isDirect: true,
        from: ownerSlack,
        threadId: `slack:dm:${ownerSlack}`,
        content,
        ...extra,
      }),
    );
  const waitForSent = <T extends { body?: string; text?: string }>(
    sent: T[],
    predicate: (post: T) => boolean,
  ) => waitFor(async () => sent.find(predicate));

  it("stops the whole space from a Slack DM, and answers the bot's messages with the paused reply", async () => {
    expect((await slackSays("/stop")).status).toBeLessThan(300);
    await waitForSent(slack.sent, (post) => post.body === "Stopped every bot in this space.");
    expect(await stops()).toEqual([
      expect.objectContaining({ scope: "space", stoppedBy: owner.userId }),
    ]);
    await waitFor(() =>
      prisma.extAuditEvent.findFirst({
        where: { spaceId: owner.spaceId, kind: "control.stop", actorId: owner.userId },
      }),
    );

    const before = await runCount();
    const handle = `slack-paused-${stamp}`;
    await app.request(
      slack.buildInboundRequest({
        isDirect: false,
        from: ownerSlack,
        threadId: `slack:C-${stamp}`,
        content: "@crew what is the status?",
        kind: "mention",
        handle,
      }),
    );
    const paused = await waitForSent(slack.sent, (post) => post.body.startsWith("Paused by"));
    expect(paused.body).toMatch(/^Paused by Dana Owner at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    expect(paused.threadId).toBe(`slack:C-${stamp}`);

    const teamsReply = await app.request(
      teams.buildInboundRequest({
        conversationType: "groupChat",
        conversationId: groupId,
        from: ownerTeams,
        text: "how is the launch going?",
        mentionBot: true,
      }),
    );
    expect(teamsReply.status).toBeLessThan(300);
    const teamsPaused = await waitForSent(teams.sent, (post) => post.text.startsWith("Paused by"));
    expect(teamsPaused.conversationId).toBe(groupId);
    // Neither message started a run or reached the team-chat queue.
    expect(await runCount()).toBe(before);
    expect(await prisma.externalMessage.count({ where: { providerEventId: handle } })).toBe(0);
  });

  it("refuses /stop and /resume from someone who is not an owner of the space", async () => {
    slack.resetWitnesses();
    await app.request(
      slack.buildInboundRequest({
        isDirect: true,
        from: memberSlack,
        threadId: `slack:dm:${memberSlack}`,
        content: "/resume",
      }),
    );
    await waitForSent(
      slack.sent,
      (post) => post.body === "Only an owner of this space can do that.",
    );
    expect(await stops()).toHaveLength(1);
    await app.request(
      slack.buildInboundRequest({
        isDirect: true,
        from: `U-STRANGER-${stamp}`,
        threadId: `slack:dm:U-STRANGER-${stamp}`,
        content: "/stop Crew",
      }),
    );
    await waitFor(async () => slack.sent.length >= 2);
    expect(slack.sent[1]!.body).toBe("Only an owner of this space can do that.");
    expect(await stops()).toHaveLength(1);
  });

  it("resumes from Slack, and stops and resumes one bot by name from a Teams channel", async () => {
    slack.resetWitnesses();
    await slackSays("/resume");
    await waitForSent(slack.sent, (post) => post.body === "Resumed this space.");
    expect(await stops()).toEqual([]);

    await app.request(
      teams.buildInboundRequest({
        conversationType: "groupChat",
        conversationId: groupId,
        from: ownerTeams,
        text: "/stop crew",
        mentionBot: true,
      }),
    );
    await waitForSent(teams.sent, (post) => post.text === "Stopped Crew.");
    expect(await stops()).toEqual([expect.objectContaining({ scope: "bot", botId: owner.botId })]);
    await app.request(
      teams.buildInboundRequest({
        conversationType: "groupChat",
        conversationId: groupId,
        from: ownerTeams,
        text: "/resume Crew",
        mentionBot: true,
      }),
    );
    await waitForSent(teams.sent, (post) => post.text === "Resumed Crew.");
    expect(await stops()).toEqual([]);
    expect(
      await prisma.extAuditEvent.count({
        where: { spaceId: owner.spaceId, kind: { in: ["control.stop", "control.resume"] } },
      }),
    ).toBe(4);
  });

  it("takes /stop typed as plain text in a Teams 1:1 chat", async () => {
    teams.resetWitnesses();
    await app.request(
      teams.buildInboundRequest({
        conversationType: "personal",
        conversationId: `a:stop-personal-${stamp}`,
        from: ownerTeams,
        text: "/stop",
      }),
    );
    await waitForSent(teams.sent, (post) => post.text === "Stopped every bot in this space.");
    expect(await stops()).toEqual([expect.objectContaining({ scope: "space" })]);
    await app.request(
      teams.buildInboundRequest({
        conversationType: "personal",
        conversationId: `a:stop-personal-${stamp}`,
        from: ownerTeams,
        text: "/resume",
      }),
    );
    await waitForSent(teams.sent, (post) => post.text === "Resumed this space.");
    expect(await stops()).toEqual([]);
  });

  it("treats /stop as ordinary text when EXT_EMERGENCY_STOP is off", async () => {
    await handles.stop();
    await boot({ ...loadExtEnv({}), auditLog: true });
    slack.resetWitnesses();
    const handle = `slack-off-${stamp}`;
    await app.request(
      slack.buildInboundRequest({
        isDirect: false,
        from: ownerSlack,
        threadId: `slack:C-off-${stamp}`,
        content: "@crew /stop",
        kind: "mention",
        handle,
      }),
    );
    await waitFor(() => prisma.externalMessage.findFirst({ where: { providerEventId: handle } }));
    expect(await stops()).toEqual([]);
    expect(slack.sent.some((post) => post.body.startsWith("Stopped"))).toBe(false);
  });
});

describeStop("fork extension: emergency stop from Slack slash commands", () => {
  const stamp = randomInt(1_000_000_000);
  const slack = new SlackEmulator();
  let handles: Handles;
  let app: App;
  let prisma: PrismaClient;
  let owner: { userId: string; spaceId: string; botId: string };
  const ownerSlack = `U-SLASH-OWNER-${stamp}`;
  const memberSlack = `U-SLASH-MEMBER-${stamp}`;

  const boot = async (ext = extOn) => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir: mkdtempSync(path.join(tmpdir(), "rakazo-stop-slash-")),
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      teamChatBotId: owner.botId,
      messaging: new ChatSdkMessagingSurface([slack.createPlatform()]),
      ext,
    });
    app = handles.app;
    prisma = handles.prisma;
  };

  beforeAll(async () => {
    const { createDb } = await import("@rakazo/db");
    const seed = createDb(process.env.DATABASE_URL!);
    const policy = { signupsEnabled: "true", signupAllowlist: "" };
    const seeded = await provisionMessagingIdentity(
      seed.prisma,
      { provider: "seed-slash", address: `owner-${stamp}`, displayName: "Sol Owner" },
      policy,
    );
    owner = { userId: seeded.userId, spaceId: seeded.spaceId, botId: seeded.botId };
    await seed.prisma.bot.update({ where: { id: owner.botId }, data: { name: "Crew" } });
    const plain = await provisionMessagingIdentity(
      seed.prisma,
      { provider: "seed-slash", address: `member-${stamp}`, displayName: "Plain Member" },
      policy,
    );
    const space = await seed.prisma.space.findUniqueOrThrow({
      where: { id: owner.spaceId },
      select: { organizationId: true },
    });
    // A database trigger adds the matching space membership.
    await seed.prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: space.organizationId,
        userId: plain.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await seed.prisma.messagingIdentity.createMany({
      data: [
        { provider: "slack", address: ownerSlack, ...owner },
        {
          provider: "slack",
          address: memberSlack,
          userId: plain.userId,
          spaceId: owner.spaceId,
          botId: owner.botId,
        },
      ],
    });
    await seed.prisma.$disconnect();
    await seed.pool.end();
    await boot();
  });

  afterAll(async () => {
    await prisma?.extControlStop.updateMany({
      where: { spaceId: owner.spaceId, resumedAt: null },
      data: { resumedAt: new Date(), resumedBy: "test-cleanup" },
    });
    await handles?.stop();
  });

  const stops = () =>
    prisma.extControlStop.findMany({ where: { spaceId: owner.spaceId, resumedAt: null } });
  const slash = (command: string, text: string, userId: string, triggerId = randomUUID()) =>
    app.request(
      slack.buildCommandRequest({ command, text, userId, channelId: `C${stamp}`, triggerId }),
    );
  const reply = (text: string) =>
    waitFor(async () => slack.responses.find((response) => response.text === text));

  it("lets an owner stop and resume a bot with signed /stop and /resume", async () => {
    const res = await slash("/stop", "crew", ownerSlack);
    expect(res.status).toBe(200);
    const stopped = await reply("Stopped Crew.");
    expect(stopped.responseType).toBe("ephemeral");
    expect(await stops()).toEqual([
      expect.objectContaining({ scope: "bot", botId: owner.botId, stoppedBy: owner.userId }),
    ]);
    const audit = await waitFor(() =>
      prisma.extAuditEvent.findFirst({
        where: { spaceId: owner.spaceId, kind: "control.stop", actorId: owner.userId },
      }),
    );
    expect(audit.summary).toContain("/stop from slack");

    await slash("/resume", "Crew", ownerSlack);
    await reply("Resumed Crew.");
    expect(await stops()).toEqual([]);
    await waitFor(() =>
      prisma.extAuditEvent.findFirst({
        where: { spaceId: owner.spaceId, kind: "control.resume", actorId: owner.userId },
      }),
    );
  });

  it("refuses a non-owner's /stop and changes nothing", async () => {
    slack.responses.length = 0;
    await slash("/stop", "", memberSlack);
    await reply("Only an owner of this space can do that.");
    await slash("/stop", "", `U-SLASH-STRANGER-${stamp}`);
    await waitFor(async () => slack.responses.length >= 2);
    expect(slack.responses[1]!.text).toBe("Only an owner of this space can do that.");
    expect(await stops()).toEqual([]);
  });

  it("rejects unsigned and replayed commands with 401 before anything runs", async () => {
    slack.responses.length = 0;
    const body = { command: "/stop", text: "", userId: ownerSlack, channelId: `C${stamp}` };
    const unsigned = await app.request(slack.buildCommandRequest(body, { sign: false }));
    expect(unsigned.status).toBe(401);
    const forged = await app.request(
      slack.buildCommandRequest(body, { signingSecret: "guessed-secret" }),
    );
    expect(forged.status).toBe(401);
    // A captured request replayed after Slack's five-minute window.
    const replayed = await app.request(
      slack.buildCommandRequest(body, { timestamp: Math.floor(Date.now() / 1000) - 600 }),
    );
    expect(replayed.status).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(slack.responses).toEqual([]);
    expect(await stops()).toEqual([]);
  });

  it("answers that the command is unavailable when EXT_EMERGENCY_STOP is off", async () => {
    await handles.stop();
    await boot({ ...loadExtEnv({}), auditLog: true });
    slack.responses.length = 0;
    expect((await slash("/stop", "", ownerSlack)).status).toBe(200);
    await reply("This command is not available.");
    expect(await stops()).toEqual([]);
    expect(await prisma.run.count({ where: { botId: owner.botId, status: "queued" } })).toBe(0);
  });
});

async function signup(app: App, email: string, name: string) {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (res.status >= 400) throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  return sessionCookieHeader(res);
}

async function createBot(handles: Handles, cookie: string, name: string): Promise<string> {
  const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
    name,
    title: name,
    description: "Test bot",
    instructions: "Complete the task.",
    notifyOnFinish: false,
  });
  await discardBotIntroRun(handles, cookie, bot.id);
  return bot.id;
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ json: body }),
  });
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}

function post(
  app: App,
  cookie: string,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function stateOf(app: App, cookie: string, query = "") {
  const res = await app.request(`${STATE}${query}`, { headers: { cookie, origin } });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    canControl: boolean;
    canControlGlobal: boolean;
    stops: Array<Record<string, unknown>>;
  };
}

async function runStatus(prisma: PrismaClient, runId: string) {
  return (await prisma.run.findUnique({ where: { id: runId }, select: { status: true } }))?.status;
}

async function queueRun(prisma: PrismaClient, botId: string): Promise<string> {
  const bot = await prisma.bot.findUniqueOrThrow({
    where: { id: botId },
    select: { spaceId: true, userId: true, thread: { select: { id: true } } },
  });
  const task = await prisma.task.create({
    data: {
      spaceId: bot.spaceId,
      botId,
      threadId: bot.thread!.id,
      userId: bot.userId,
      prompt: "queued while stopped",
      status: "queued",
    },
  });
  const run = await prisma.run.create({
    data: {
      spaceId: bot.spaceId,
      botId,
      threadId: bot.thread!.id,
      taskId: task.id,
      userId: bot.userId,
      status: "queued",
      trigger: "user",
    },
  });
  return run.id;
}

async function waitFor<T>(predicate: () => Promise<T | false | null | undefined>): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    const value = await predicate();
    if (value) return value as T;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for state");
}
