import { randomInt, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ChatSdkMessagingSurface,
  ComposioEmulator,
  SlackEmulator,
  TeamsEmulator,
} from "@rakazo/adapters";
import { loadExtEnv } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { decideApproval, getEmergencyStop, recordStop, saveApprovalPolicy } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string | Request, init?: RequestInit) => Promise<Response> };
type Handles = Awaited<ReturnType<typeof createApp>>;
type Person = { cookie: string; userId: string; spaceId: string };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeApprovals = hasDb ? describe.sequential : describe.skip;
const origin = "http://127.0.0.1:5173";
const extOn = { ...loadExtEnv({}), auditLog: true, emergencyStop: true, approvals: true };
const PROMPT = "write this to the destination crm as a note";
const POLICY = "/api/v1/approvals/bots";
const TIMEOUT = 60_000;

describeApprovals("fork extension: approvals from Slack, Teams and the web", () => {
  const stamp = `${Date.now()}-${randomInt(1_000_000)}`;
  const slack = new SlackEmulator();
  const teams = new TeamsEmulator();
  let handles: Handles;
  let app: App;
  let prisma: PrismaClient;
  const people: Record<"owner" | "member" | "stranger", Person> = {} as never;
  let botId: string;
  let strangerBotId: string;
  const ownerSlack = `U-APPR-OWNER-${stamp}`;
  const memberSlack = `U-APPR-MEMBER-${stamp}`;
  const strangerSlack = `U-APPR-STRANGER-${stamp}`;
  const ownerTeams = `29:appr-owner-${stamp}`;
  const dmChannel = `D${stamp.replace(/\D/g, "").slice(-9)}`;
  const teamsConversation = `a:appr-${stamp}`;

  const boot = async (ext = extOn) => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir: mkdtempSync(path.join(tmpdir(), "rakazo-approvals-")),
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      composio: new ComposioEmulator(),
      messaging: new ChatSdkMessagingSurface([slack.createPlatform(), teams.createPlatform()]),
      ext,
    });
    app = handles.app;
    prisma = handles.prisma;
  };

  const surface = () => handles.messaging as ChatSdkMessagingSurface;

  beforeAll(async () => {
    await boot();
    for (const [key, name] of [
      ["owner", "Ada Owner"],
      ["member", "Max Member"],
      ["stranger", "Bea Stranger"],
    ] as const) {
      const email = `appr-${key}-${stamp}@rakazo.test`;
      const cookie = await signup(app, email, name);
      const user = await prisma.user.findFirstOrThrow({ where: { email }, select: { id: true } });
      const membership = await prisma.spaceMember.findFirstOrThrow({
        where: { userId: user.id },
        select: { spaceId: true },
      });
      people[key] = { cookie, userId: user.id, spaceId: membership.spaceId };
    }
    await joinOwnerSpace(people.member.userId);
    botId = await createBot(handles, people.owner.cookie, "Crew");
    strangerBotId = await createBot(handles, people.stranger.cookie, "Other");
    const owner = { userId: people.owner.userId, spaceId: people.owner.spaceId, botId };
    await prisma.messagingIdentity.createMany({
      data: [
        { provider: "slack", address: ownerSlack, ...owner },
        { provider: "teams", address: ownerTeams, ...owner },
        { provider: "slack", address: memberSlack, ...owner, userId: people.member.userId },
        {
          provider: "slack",
          address: strangerSlack,
          userId: people.stranger.userId,
          spaceId: people.stranger.spaceId,
          botId: strangerBotId,
        },
      ],
    });
  }, TIMEOUT);

  afterAll(async () => {
    await prisma?.extControlStop.updateMany({
      where: { spaceId: people.owner?.spaceId, resumedAt: null },
      data: { resumedAt: new Date(), resumedBy: "test-cleanup" },
    });
    await handles?.stop();
  });

  async function joinOwnerSpace(userId: string) {
    const space = await prisma.space.findUniqueOrThrow({
      where: { id: people.owner.spaceId },
      select: { organizationId: true },
    });
    // A database trigger adds the matching space membership.
    await prisma.member.createMany({
      data: [
        {
          id: randomUUID(),
          organizationId: space.organizationId,
          userId,
          role: "member",
          createdAt: new Date(),
        },
      ],
      skipDuplicates: true,
    });
  }

  const records = () => handles.connector.records.length;

  const setApprovers = (approverUserIds: string[]) =>
    prisma.$transaction((tx) =>
      saveApprovalPolicy(tx, {
        spaceId: people.owner.spaceId,
        botId,
        actorId: people.owner.userId,
        patch: { approverUserIds },
      }),
    );

  /** A Slack DM from the owner that makes the bot call destination.write, paused for approval. */
  async function gatedCallFromSlack() {
    const before = await prisma.extApproval.count({ where: { botId } });
    const res = await app.request(
      slack.buildEventRequest({
        text: PROMPT,
        userId: ownerSlack,
        channelId: dmChannel,
        channelType: "im",
      }),
    );
    expect(res.status).toBeLessThan(300);
    return waitForCard(before);
  }

  async function gatedCallFromTeams() {
    const before = await prisma.extApproval.count({ where: { botId } });
    const res = await app.request(
      teams.buildInboundRequest({
        from: ownerTeams,
        text: PROMPT,
        conversationType: "personal",
        conversationId: teamsConversation,
      }),
    );
    expect(res.status).toBeLessThan(300);
    return waitForCard(before);
  }

  async function waitForCard(before: number) {
    const approval = await waitFor(async () => {
      const rows = await prisma.extApproval.findMany({
        where: { botId, status: "pending", cardMessageId: { not: null } },
        orderBy: { createdAt: "desc" },
      });
      return rows.length && (await prisma.extApproval.count({ where: { botId } })) > before
        ? rows[0]
        : null;
    });
    await waitFor(async () =>
      (await prisma.run.findUnique({ where: { id: approval.runId } }))?.status === "waiting_input"
        ? true
        : null,
    );
    return approval;
  }

  async function settled(runId: string) {
    return waitFor(async () => {
      const run = await prisma.run.findUnique({ where: { id: runId } });
      return run && ["completed", "failed", "cancelled"].includes(run.status) ? run : null;
    });
  }

  const click = async (
    userId: string,
    approval: { id: string; cardMessageId: string | null },
    action: "allow" | "deny",
    extra: { triggerId?: string; value?: string } = {},
  ) => {
    const res = await app.request(
      slack.buildActionRequest({
        userId,
        actionId: action === "allow" ? "ext_approval_allow" : "ext_approval_deny",
        value: extra.value ?? approval.id,
        channelId: dmChannel,
        messageTs: approval.cardMessageId ?? undefined,
        triggerId: extra.triggerId,
      }),
    );
    await surface().drainActions();
    return res;
  };

  const effectOf = (approval: { effectId: string }) =>
    prisma.externalEffect.findUniqueOrThrow({ where: { id: approval.effectId } });
  const statusOf = async (approval: { id: string }) =>
    (await prisma.extApproval.findUniqueOrThrow({ where: { id: approval.id } })).status;

  it(
    "posts a Block Kit card and runs the tool once after a signed Slack approval, audited",
    async () => {
      const approval = await gatedCallFromSlack();
      expect(approval).toMatchObject({
        toolName: "destination.write",
        riskClass: "write-external",
        cardProvider: "slack",
      });
      expect(approval.approverIds).toEqual([people.owner.userId]);
      const card = slack.posted.find((post) => post.ts === approval.cardMessageId);
      expect(JSON.stringify(card?.blocks)).toContain("ext_approval_allow");
      expect(JSON.stringify(card?.blocks)).toContain("destination.write");
      // The web card is the same request, without "Always allow".
      const ask = await askBlock(approval.runId);
      expect(ask?.actions?.map((a) => a.id)).toEqual(["allow", "deny"]);

      const before = records();
      expect((await click(ownerSlack, approval, "allow")).status).toBe(200);
      const run = await settled(approval.runId);
      expect(run.status).toBe("completed");
      expect(records()).toBe(before + 1);
      expect(await statusOf(approval)).toBe("allow");
      expect((await effectOf(approval)).status).toBe("completed");
      expect((await askBlock(approval.runId))?.status).toBe("answered");
      expect(
        slack.updated.some((u) => JSON.stringify(u.blocks).includes("Approved by Ada Owner")),
      ).toBe(true);

      const audit = await prisma.extAuditEvent.findMany({
        where: { runId: approval.runId, kind: { in: ["approval.request", "approval.decision"] } },
        orderBy: { seq: "asc" },
      });
      expect(audit.map((event) => event.kind)).toEqual(["approval.request", "approval.decision"]);
      expect(audit[0]!.detail).toMatchObject({
        tool: "destination.write",
        riskClass: "write-external",
      });
      expect(audit[1]).toMatchObject({ actorType: "human", actorId: people.owner.userId });
      expect(audit[1]!.detail).toMatchObject({ decision: "allow", via: "slack" });
    },
    TIMEOUT,
  );

  it(
    "runs once after an Adaptive Card approval through a JWT-validated Teams invoke",
    async () => {
      const approval = await gatedCallFromTeams();
      expect(approval.cardProvider).toBe("teams");
      const card = teams.sent.find((sent) => sent.attachments?.length);
      expect(JSON.stringify(card?.attachments)).toContain("ext_approval_allow");
      const before = records();
      const res = await app.request(
        teams.buildInvokeRequest({
          from: ownerTeams,
          actionId: "ext_approval_allow",
          value: approval.id,
          conversationId: teamsConversation,
          replyToId: approval.cardMessageId!,
        }),
      );
      expect(res.status).toBeLessThan(300);
      await surface().drainActions();
      expect((await settled(approval.runId)).status).toBe("completed");
      expect(records()).toBe(before + 1);
      expect(await statusOf(approval)).toBe("allow");
      expect(teams.updated.some((u) => JSON.stringify(u.attachments).includes("Approved by"))).toBe(
        true,
      );
      // A forged token never reaches the decision.
      const forged = teams.buildInvokeRequest(
        { from: ownerTeams, actionId: "ext_approval_deny", value: approval.id },
        teams.token({ aud: "another-app" }),
      );
      expect((await app.request(forged)).status).toBeGreaterThanOrEqual(400);
    },
    TIMEOUT,
  );

  it(
    "denies: nothing runs and the model gets the declined result",
    async () => {
      const approval = await gatedCallFromSlack();
      const before = records();
      await click(ownerSlack, approval, "deny");
      expect((await settled(approval.runId)).status).toBe("completed");
      expect(records()).toBe(before);
      expect(await statusOf(approval)).toBe("deny");
      expect((await effectOf(approval)).status).toBe("denied");
      expect(
        slack.updated.some((u) => JSON.stringify(u.blocks).includes("Denied by Ada Owner")),
      ).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "expires after 30 minutes as a deny (fake clock)",
    async () => {
      const approval = await gatedCallFromSlack();
      const before = records();
      // Not yet: one minute short of the deadline nothing closes. (The sweep is global, so
      // assert on this request rather than on how many others it closed.)
      await handles.approvals!.sweep(new Date(approval.expiresAt.getTime() - 60_000));
      expect(await statusOf(approval)).toBe("pending");
      await handles.approvals!.sweep(new Date(approval.expiresAt.getTime() + 1_000));
      expect((await settled(approval.runId)).status).toBe("completed");
      expect(await statusOf(approval)).toBe("expired");
      expect((await effectOf(approval)).status).toBe("denied");
      expect(records()).toBe(before);
      expect(slack.updated.some((u) => JSON.stringify(u.blocks).includes("Expired"))).toBe(true);
      // A click after the expiry changes nothing.
      await click(ownerSlack, approval, "allow");
      expect(records()).toBe(before);
    },
    TIMEOUT,
  );

  it(
    "refuses a non-approver's click and a forged payload, then a replayed click is a no-op",
    async () => {
      const approval = await gatedCallFromSlack();
      const before = records();
      slack.resetWitnesses();
      // A member of the space who is not an approver.
      await click(memberSlack, approval, "allow");
      expect(slack.responses.map((r) => r.text)).toContain("You can't decide this approval.");
      expect(await statusOf(approval)).toBe("pending");
      // A signed click by the member whose button value claims to be the owner.
      await click(memberSlack, approval, "allow", {
        value: JSON.stringify({ approvalId: approval.id, userId: people.owner.userId }),
      });
      expect(await statusOf(approval)).toBe("pending");
      // An unsigned click that claims the owner's Slack id is rejected before anything runs.
      const unsigned = await app.request(
        slack.buildActionRequest(
          {
            userId: ownerSlack,
            actionId: "ext_approval_allow",
            value: approval.id,
            channelId: dmChannel,
          },
          { sign: false },
        ),
      );
      expect(unsigned.status).toBe(401);
      const signedByStranger = await app.request(
        slack.buildActionRequest(
          {
            userId: ownerSlack,
            actionId: "ext_approval_allow",
            value: approval.id,
            channelId: dmChannel,
          },
          { signingSecret: "attacker-secret" },
        ),
      );
      expect(signedByStranger.status).toBe(401);
      await surface().drainActions();
      expect(await statusOf(approval)).toBe("pending");
      expect(records()).toBe(before);
      const refusals = await prisma.extApproval.findUniqueOrThrow({ where: { id: approval.id } });
      expect(refusals.decidedBy).toBeNull();

      // The owner approves; Slack retries the same interaction, then the owner clicks again.
      await click(ownerSlack, approval, "allow", { triggerId: `trigger-${approval.id}` });
      await click(ownerSlack, approval, "allow", { triggerId: `trigger-${approval.id}` });
      await settled(approval.runId);
      await click(ownerSlack, approval, "deny", { triggerId: `trigger-late-${approval.id}` });
      expect(slack.responses.map((r) => r.text)).toContain("This approval was already decided.");
      expect(records()).toBe(before + 1);
      expect(await statusOf(approval)).toBe("allow");
      expect(
        await prisma.extAuditEvent.count({
          where: { runId: approval.runId, kind: "approval.decision" },
        }),
      ).toBe(1);
    },
    TIMEOUT,
  );

  it(
    "keeps spaces apart: another space's linked user cannot decide",
    async () => {
      const approval = await gatedCallFromSlack();
      slack.resetWitnesses();
      await click(strangerSlack, approval, "allow");
      expect(slack.responses.map((r) => r.text)).toContain("You can't decide this approval.");
      expect(await statusOf(approval)).toBe("pending");
      // Nor from the web: space B cannot reach space A's thread.
      const ask = await askMessage(approval.runId);
      const res = await rpcRaw(app, people.stranger.cookie, "threads/answer", {
        botId,
        runId: approval.runId,
        messageId: ask.id,
        answer: "allow",
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await statusOf(approval)).toBe("pending");
      await click(ownerSlack, approval, "deny");
      await settled(approval.runId);
    },
    TIMEOUT,
  );

  it(
    "updates the chat card when decided in the web app, and nothing runs twice",
    async () => {
      // The web card sits in the bot's thread, which only the bot's owner sees. When the
      // owner is not a listed approver, the web answer is refused like a stranger's click.
      await setApprovers([people.member.userId]);
      try {
        const memberOnly = await gatedCallFromSlack();
        const memberAsk = await askMessage(memberOnly.runId);
        const refused = await rpcRaw(app, people.owner.cookie, "threads/answer", {
          botId,
          runId: memberOnly.runId,
          messageId: memberAsk.id,
          answer: "allow",
        });
        expect(refused.status).toBe(403);
        expect(await statusOf(memberOnly)).toBe("pending");
        await click(memberSlack, memberOnly, "deny");
        await settled(memberOnly.runId);
        expect(await statusOf(memberOnly)).toBe("deny");
      } finally {
        await setApprovers([]);
      }

      const approval = await gatedCallFromSlack();
      const before = records();
      const ask = await askMessage(approval.runId);
      // "Always allow" is not offered for a gated call.
      const always = await rpcRaw(app, people.owner.cookie, "threads/answer", {
        botId,
        runId: approval.runId,
        messageId: ask.id,
        answer: "always",
      });
      expect(always.status).toBe(400);
      const res = await rpcRaw(app, people.owner.cookie, "threads/answer", {
        botId,
        runId: approval.runId,
        messageId: ask.id,
        answer: "allow",
      });
      expect(res.status).toBe(200);
      await settled(approval.runId);
      expect(records()).toBe(before + 1);
      expect(
        slack.updated.some(
          (u) =>
            u.ts === approval.cardMessageId && JSON.stringify(u.blocks).includes("Approved by"),
        ),
      ).toBe(true);
      slack.resetWitnesses();
      await click(ownerSlack, approval, "allow");
      expect(slack.responses.map((r) => r.text)).toContain("This approval was already decided.");
      expect(records()).toBe(before + 1);
      expect(
        await prisma.extAuditEvent.count({
          where: { runId: approval.runId, kind: "approval.decision" },
        }),
      ).toBe(1);
      expect(
        await prisma.extApproval.findUniqueOrThrow({ where: { id: approval.id } }),
      ).toMatchObject({ status: "allow", decidedVia: "web" });
    },
    TIMEOUT,
  );

  it(
    "invalidates the request when its only approver leaves the space",
    async () => {
      await prisma.$transaction((tx) =>
        saveApprovalPolicy(tx, {
          spaceId: people.owner.spaceId,
          botId,
          actorId: people.owner.userId,
          patch: { approverUserIds: [people.member.userId] },
        }),
      );
      try {
        const approval = await gatedCallFromSlack();
        expect(approval.approverIds).toEqual([people.member.userId]);
        const before = records();
        const space = await prisma.space.findUniqueOrThrow({
          where: { id: people.owner.spaceId },
          select: { organizationId: true },
        });
        await prisma.member.deleteMany({
          where: { organizationId: space.organizationId, userId: people.member.userId },
        });
        slack.resetWitnesses();
        await click(memberSlack, approval, "allow");
        expect(slack.responses.map((r) => r.text)).toContain("You can't decide this approval.");
        await handles.approvals!.sweep();
        expect((await settled(approval.runId)).status).toBe("completed");
        expect(await statusOf(approval)).toBe("invalid");
        expect((await effectOf(approval)).status).toBe("denied");
        expect(records()).toBe(before);
        expect(
          slack.updated.some((u) => JSON.stringify(u.blocks).includes("No longer valid")),
        ).toBe(true);
      } finally {
        await prisma.$transaction((tx) =>
          saveApprovalPolicy(tx, {
            spaceId: people.owner.spaceId,
            botId,
            actorId: people.owner.userId,
            patch: { approverUserIds: [] },
          }),
        );
        await joinOwnerSpace(people.member.userId);
      }
    },
    TIMEOUT,
  );

  it(
    "never executes a stopped bot's call: approved after the stop, or stopped after approval",
    async () => {
      // Stopped before the click: the decision itself refuses to approve.
      const first = await gatedCallFromSlack();
      const before = records();
      const stop = await post(app, people.owner.cookie, "/api/v1/control/stop", {
        scope: "bot",
        botId,
        reason: "test",
      });
      try {
        expect(stop.status).toBe(200);
        await click(ownerSlack, first, "allow");
        expect(await statusOf(first)).toBe("invalid");
        expect(records()).toBe(before);
      } finally {
        await post(app, people.owner.cookie, "/api/v1/control/resume", {
          scope: "bot",
          botId,
          reason: "test",
        });
      }

      const reader = getEmergencyStop()!;
      const lateStop = () =>
        // Written straight to the table, as another API process would: this process's one
        // second stop cache still says "running" (primed just before).
        recordStop(prisma, {
          scope: "bot",
          spaceId: people.owner.spaceId,
          botId,
          reason: "late stop",
          userId: people.owner.userId,
        });
      const resume = () =>
        post(app, people.owner.cookie, "/api/v1/control/resume", {
          scope: "bot",
          botId,
          reason: "test",
        });
      const cancelLeftover = (runId: string) =>
        prisma.run.updateMany({
          where: { id: runId, status: { in: ["queued", "waiting_input"] } },
          data: { status: "cancelled" },
        });

      // Stopped elsewhere a moment ago: the decision reads the stop state fresh and refuses.
      const second = await gatedCallFromSlack();
      try {
        expect(await reader.check({ spaceId: people.owner.spaceId, botId })).toBeNull();
        await lateStop();
        const refused = await decideApproval(prisma, {
          approvalId: second.id,
          decider: { type: "human", userId: people.owner.userId },
          answer: "allow",
          via: "web",
        });
        expect(refused).toMatchObject({ status: "decided", outcome: "invalid" });
        expect((await effectOf(second)).status).toBe("denied");
      } finally {
        await resume();
        await cancelLeftover(second.runId);
      }

      // Approved, then the stop lands before the run resumes: the run's cached guard lets it
      // start, and the execution-time check (a fresh read) keeps the side effect from running.
      const third = await gatedCallFromSlack();
      try {
        const approved = await decideApproval(prisma, {
          approvalId: third.id,
          decider: { type: "human", userId: people.owner.userId },
          answer: "allow",
          via: "web",
        });
        expect(approved).toMatchObject({ status: "decided", outcome: "allow" });
        expect(await reader.check({ spaceId: people.owner.spaceId, botId })).toBeNull();
        await lateStop();
        await handles.executor.continueRun(third.runId, "approvals-test-worker");
        await settled(third.runId);
        expect(records()).toBe(before);
        expect((await effectOf(third)).status).toBe("approved");
      } finally {
        await resume();
        await cancelLeftover(third.runId);
      }
    },
    TIMEOUT,
  );

  it(
    "lets only a space owner read and change the bot's approval policy, audited",
    async () => {
      const read = await app.request(`${POLICY}/${botId}`, {
        headers: { cookie: people.owner.cookie, origin },
      });
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({
        policy: { gatedClasses: ["write-external"], approverUserIds: [] },
        members: expect.arrayContaining([
          expect.objectContaining({ userId: people.member.userId, owner: false }),
        ]),
      });
      const put = (person: Person, body: unknown, query = "") =>
        app.request(`${POLICY}/${botId}${query}`, {
          method: "PUT",
          headers: { "content-type": "application/json", cookie: person.cookie, origin },
          body: JSON.stringify(body),
        });
      expect((await put(people.member, { gatedClasses: [] })).status).toBe(404);
      expect((await put(people.stranger, { gatedClasses: [] })).status).toBe(404);
      expect((await put(people.owner, { gatedClasses: ["nope"] })).status).toBe(400);
      expect((await put(people.owner, { approverUserIds: [people.stranger.userId] })).status).toBe(
        400,
      );
      const changed = await put(
        people.owner,
        {
          gatedClasses: ["write-internal", "write-external"],
          approverUserIds: [people.member.userId],
          spaceId: people.stranger.spaceId,
        },
        `?spaceId=${people.stranger.spaceId}`,
      );
      expect(changed.status).toBe(200);
      expect((await changed.json()).policy).toEqual({
        gatedClasses: ["write-internal", "write-external"],
        approverUserIds: [people.member.userId],
      });
      const row = await prisma.extBotApprovalPolicy.findUniqueOrThrow({ where: { botId } });
      expect(row.spaceId).toBe(people.owner.spaceId);
      expect(
        await prisma.extAuditEvent.findFirst({
          where: { spaceId: people.owner.spaceId, kind: "policy.change", botId },
        }),
      ).toBeTruthy();
      expect(
        (await put(people.owner, { gatedClasses: ["write-external"], approverUserIds: [] })).status,
      ).toBe(200);
      const modules = await app.request("/api/v1/ext/modules", {
        headers: { cookie: people.owner.cookie, origin },
      });
      expect(await modules.json()).toMatchObject({ approvals: true });
    },
    TIMEOUT,
  );

  it(
    "changes nothing with EXT_APPROVALS off: no gate, no card, no endpoint",
    async () => {
      await handles.stop();
      await boot({ ...extOn, approvals: false });
      slack.resetWitnesses();
      const approvalsBefore = await prisma.extApproval.count({ where: { botId } });
      const before = records();
      await app.request(
        slack.buildEventRequest({
          text: PROMPT,
          userId: ownerSlack,
          channelId: dmChannel,
          channelType: "im",
        }),
      );
      await waitFor(async () => (records() > before ? true : null));
      expect(records()).toBe(before + 1);
      expect(await prisma.extApproval.count({ where: { botId } })).toBe(approvalsBefore);
      expect(
        slack.posted.some((post) => JSON.stringify(post.blocks ?? []).includes("ext_approval")),
      ).toBe(false);
      const policy = await app.request(`${POLICY}/${botId}`, {
        headers: { cookie: people.owner.cookie, origin },
      });
      expect(policy.status).toBe(404);
      const modules = await app.request("/api/v1/ext/modules", {
        headers: { cookie: people.owner.cookie, origin },
      });
      expect(await modules.json()).toMatchObject({ approvals: false });
      // A click on an old card is acknowledged and ignored.
      const stale = await app.request(
        slack.buildActionRequest({
          userId: ownerSlack,
          actionId: "ext_approval_allow",
          value: "anything",
          channelId: dmChannel,
        }),
      );
      expect(stale.status).toBe(200);
      await surface().drainActions();
      expect(slack.responses).toEqual([]);
    },
    TIMEOUT,
  );

  async function askMessage(runId: string) {
    return prisma.message.findFirstOrThrow({
      where: { runId, role: "bot", blocks: { array_contains: [{ kind: "ask" }] } },
      orderBy: { seq: "desc" },
    });
  }

  async function askBlock(runId: string) {
    const message = await askMessage(runId);
    return (
      message.blocks as Array<{ kind: string; status?: string; actions?: Array<{ id: string }> }>
    ).find((block) => block.kind === "ask");
  }
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
  const res = await rpcRaw(handles.app, cookie, "bots/create", {
    name,
    title: name,
    description: "Test bot",
    instructions: "Complete the task.",
    notifyOnFinish: false,
  });
  const bot = ((await res.json()) as { json: { id: string } }).json;
  await discardBotIntroRun(handles, cookie, bot.id);
  return bot.id;
}

function rpcRaw(app: App, cookie: string, proc: string, body: unknown, spaceId?: string) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin,
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
    },
    body: JSON.stringify({ json: body }),
  });
}

function post(app: App, cookie: string, url: string, body: unknown) {
  return app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie },
    body: JSON.stringify(body),
  });
}

async function waitFor<T>(predicate: () => Promise<T | false | null | undefined>): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    const value = await predicate();
    if (value) return value as T;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for state");
}
