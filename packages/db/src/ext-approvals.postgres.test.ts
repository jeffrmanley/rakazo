import { randomUUID } from "node:crypto";
import { approvalCallHash } from "@rakazo/core/node/approval-effect-key";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { pauseRunForInput } from "./events.js";
import {
  assertApprovalsFlag,
  checkApprovedCall,
  createApprovalRequest,
  decideApproval,
  findApprovalsToClose,
  loadApprovalPolicy,
  loadSpaceRoster,
  recordApprovalsFlag,
  saveApprovalPolicy,
} from "./ext-approvals.js";
import type { AuditWriter } from "./ext-audit.js";
import { AuditWriteError, createAuditWriter, installAuditWriter } from "./ext-audit.js";
import type { EmergencyStopReader } from "./ext-emergency-stop.js";
import { installEmergencyStop } from "./ext-emergency-stop.js";
import { provisionMessagingIdentity } from "./messaging.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

type Target = { userId: string; spaceId: string; botId: string; threadId: string };

describePostgres("ext approvals (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let owner: Target;
  let other: Target;
  let memberId: string;

  const provision = async (name: string): Promise<Target> => {
    const ids = await provisionMessagingIdentity(
      prisma,
      { provider: "ext-approvals-test", address: `${name}-${suffix}`, displayName: name },
      { signupsEnabled: "true", signupAllowlist: "" },
    );
    return { userId: ids.userId, spaceId: ids.spaceId, botId: ids.botId, threadId: ids.threadId };
  };

  /** A run paused on an approval card for one intended effect, as the executor leaves it. */
  const pendingCall = async (target: Target, args: Record<string, unknown> = { to: "a" }) => {
    const task = await prisma.task.create({
      data: { ...pick(target), prompt: "send it", status: "running" },
    });
    const run = await prisma.run.create({
      data: {
        ...pick(target),
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: "worker-1",
        leaseFence: 1,
      },
    });
    const attempt = await prisma.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId: target.spaceId,
        runId: run.id,
        kind: "gmail_send_email",
        idempotencyKey: `${run.id}:gmail_send_email:${randomUUID()}`,
        status: "intended",
        request: { tool: "gmail_send_email", args } as never,
      },
    });
    const approval = await createApprovalRequest(prisma, {
      spaceId: target.spaceId,
      botId: target.botId,
      runId: run.id,
      threadId: target.threadId,
      effectId: effect.id,
      toolName: "gmail_send_email",
      riskClass: "write-external",
      callHash: approvalCallHash("gmail_send_email", args),
      args: { ...args, api_key: "sk-test-should-not-be-stored-0123456789" },
      reason: "Sending the weekly report",
      requestedBy: target.userId,
      secrets: [],
    });
    const paused = await pauseRunForInput(prisma, {
      spaceId: target.spaceId,
      threadId: target.threadId,
      botId: target.botId,
      runId: run.id,
      attemptId: attempt.id,
      leaseOwner: "worker-1",
      leaseFence: 1,
      blocks: [
        {
          kind: "ask",
          approvalEffectId: effect.id,
          text: "Review before gmail_send_email",
          status: "pending",
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ],
        },
      ],
    });
    expect(paused).toBe(true);
    return { run, effect, approval };
  };

  const state = async (call: Awaited<ReturnType<typeof pendingCall>>) => ({
    approval: (await prisma.extApproval.findUniqueOrThrow({ where: { id: call.approval.id } }))
      .status,
    effect: (await prisma.externalEffect.findUniqueOrThrow({ where: { id: call.effect.id } }))
      .status,
    run: (await prisma.run.findUniqueOrThrow({ where: { id: call.run.id } })).status,
  });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    owner = await provision("owner");
    other = await provision("other");
    // A plain member of the owner's space (a database trigger adds the space membership).
    const member = await provision("member");
    memberId = member.userId;
    const space = await prisma.space.findUniqueOrThrow({
      where: { id: owner.spaceId },
      select: { organizationId: true },
    });
    await prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId: space.organizationId,
        userId: memberId,
        role: "member",
        createdAt: new Date(),
      },
    });
  });

  afterEach(() => {
    installAuditWriter(null);
    installEmergencyStop(null);
  });

  afterAll(async () => {
    await close?.();
  });

  it("records the request redacted, with the owner and the requester as approvers", async () => {
    installAuditWriter(createAuditWriter(prisma));
    const call = await pendingCall(owner);
    expect(call.approval).toMatchObject({
      status: "pending",
      riskClass: "write-external",
      approverIds: [owner.userId],
      reason: "Sending the weekly report",
    });
    expect(JSON.stringify(call.approval.args)).not.toContain("sk-test-should-not-be-stored");
    expect(call.approval.expiresAt.getTime() - call.approval.createdAt.getTime()).toBe(30 * 60_000);
    const audit = await prisma.extAuditEvent.findFirstOrThrow({
      where: { spaceId: owner.spaceId, runId: call.run.id, kind: "approval.request" },
    });
    expect(audit.detail).toMatchObject({ tool: "gmail_send_email", riskClass: "write-external" });
    expect(JSON.stringify(audit.detail)).not.toContain("sk-test-should-not-be-stored");
  });

  it("decides exactly once: the run resumes with the effect approved, a second click is a no-op", async () => {
    installAuditWriter(createAuditWriter(prisma));
    const call = await pendingCall(owner);
    const first = await decideApproval(prisma, {
      approvalId: call.approval.id,
      decider: { type: "human", userId: owner.userId },
      answer: "allow",
      via: "slack",
      interactionId: "trigger-1",
    });
    expect(first).toMatchObject({ status: "decided", outcome: "allow", resumed: true });
    expect(await state(call)).toEqual({ approval: "allow", effect: "approved", run: "queued" });
    const again = await decideApproval(prisma, {
      approvalId: call.approval.id,
      decider: { type: "human", userId: owner.userId },
      answer: "deny",
      via: "teams",
    });
    expect(again.status).toBe("already_decided");
    expect(await state(call)).toEqual({ approval: "allow", effect: "approved", run: "queued" });
    const decisions = await prisma.extAuditEvent.findMany({
      where: { runId: call.run.id, kind: "approval.decision" },
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ actorType: "human", actorId: owner.userId });
    expect(decisions[0]!.detail).toMatchObject({ decision: "allow", via: "slack" });
  });

  it("lets only one of two simultaneous decisions win", async () => {
    const call = await pendingCall(owner);
    const results = await Promise.all(
      (["allow", "deny", "allow", "deny"] as const).map((answer, index) =>
        decideApproval(prisma, {
          approvalId: call.approval.id,
          decider: { type: "human", userId: owner.userId },
          answer,
          via: index % 2 ? "web" : "slack",
        }),
      ),
    );
    expect(results.filter((result) => result.status === "decided")).toHaveLength(1);
    expect(results.filter((result) => result.status === "already_decided")).toHaveLength(3);
    const final = await state(call);
    expect(["allow", "deny"]).toContain(final.approval);
    expect(final.effect).toBe(final.approval === "allow" ? "approved" : "denied");
  });

  it("refuses a member who is not an approver and changes nothing", async () => {
    const call = await pendingCall(owner);
    const result = await decideApproval(prisma, {
      approvalId: call.approval.id,
      decider: { type: "human", userId: memberId },
      answer: "allow",
      via: "slack",
    });
    expect(result).toMatchObject({ status: "not_allowed", reason: "not_listed" });
    expect(await state(call)).toEqual({
      approval: "pending",
      effect: "intended",
      run: "waiting_input",
    });
  });

  it("never finds another space's request (tenant isolation)", async () => {
    const call = await pendingCall(owner);
    const fromB = await decideApproval(prisma, {
      approvalId: call.approval.id,
      spaceId: other.spaceId,
      decider: { type: "human", userId: other.userId },
      answer: "allow",
      via: "web",
    });
    expect(fromB.status).toBe("not_found");
    // Without a space filter the identity check still refuses a stranger.
    const stranger = await decideApproval(prisma, {
      approvalId: call.approval.id,
      decider: { type: "human", userId: other.userId },
      answer: "allow",
      via: "slack",
    });
    expect(stranger.status).toBe("not_allowed");
    expect((await state(call)).approval).toBe("pending");
  });

  it("expires after 30 minutes as a deny, whatever is clicked afterwards", async () => {
    installAuditWriter(createAuditWriter(prisma));
    const call = await pendingCall(owner);
    const later = new Date(call.approval.expiresAt.getTime() + 1_000);
    expect(await findApprovalsToClose(prisma, later)).toContainEqual({
      id: call.approval.id,
      reason: "expired",
    });
    const late = await decideApproval(prisma, {
      approvalId: call.approval.id,
      decider: { type: "human", userId: owner.userId },
      answer: "allow",
      via: "web",
      now: later,
    });
    expect(late).toMatchObject({ status: "decided", outcome: "expired" });
    expect(await state(call)).toEqual({ approval: "expired", effect: "denied", run: "queued" });
    const audit = await prisma.extAuditEvent.findFirstOrThrow({
      where: { runId: call.run.id, kind: "approval.decision" },
    });
    expect(audit.detail).toMatchObject({ decision: "expired" });
  });

  it("invalidates a request whose only approver left the space", async () => {
    const space = await prisma.space.findUniqueOrThrow({
      where: { id: owner.spaceId },
      select: { organizationId: true },
    });
    await saveApprovalPolicyFor(owner, [memberId]);
    const call = await pendingCall(owner);
    expect(call.approval.approverIds).toEqual([memberId]);
    await prisma.member.deleteMany({
      where: { organizationId: space.organizationId, userId: memberId },
    });
    const left = await decideApproval(prisma, {
      approvalId: call.approval.id,
      decider: { type: "human", userId: memberId },
      answer: "allow",
      via: "slack",
    });
    expect(left).toMatchObject({ status: "not_allowed", reason: "left" });
    expect(await findApprovalsToClose(prisma, new Date())).toContainEqual({
      id: call.approval.id,
      reason: "no_approver",
    });
    const closed = await decideApproval(prisma, {
      approvalId: call.approval.id,
      decider: { type: "system" },
      answer: "deny",
      via: "system",
    });
    expect(closed).toMatchObject({ status: "decided", outcome: "invalid" });
    expect(await state(call)).toEqual({ approval: "invalid", effect: "denied", run: "queued" });
    await saveApprovalPolicyFor(owner, []);
  });

  it("closes a request whose run already ended (a stop cancelled it)", async () => {
    const call = await pendingCall(owner);
    await prisma.run.update({ where: { id: call.run.id }, data: { status: "cancelled" } });
    expect(await findApprovalsToClose(prisma, new Date())).toContainEqual({
      id: call.approval.id,
      reason: "run_ended",
    });
    const closed = await decideApproval(prisma, {
      approvalId: call.approval.id,
      decider: { type: "system" },
      answer: "deny",
      via: "system",
      note: "The run ended before a decision",
    });
    expect(closed).toMatchObject({ status: "decided", outcome: "invalid", resumed: false });
    expect(await state(call)).toMatchObject({ approval: "invalid", run: "cancelled" });
  });

  it("does not approve a stopped bot's call", async () => {
    const call = await pendingCall(owner);
    installEmergencyStop({
      check: async () => ({ id: "stop-1" }),
      invalidate: () => undefined,
    } as unknown as EmergencyStopReader);
    const result = await decideApproval(prisma, {
      approvalId: call.approval.id,
      decider: { type: "human", userId: owner.userId },
      answer: "allow",
      via: "slack",
    });
    expect(result).toMatchObject({ status: "decided", outcome: "invalid" });
    expect((await state(call)).effect).toBe("denied");
  });

  it("fails closed when the audit write fails: no request, or the decision stays pending", async () => {
    const failing: AuditWriter = {
      record: async () => {
        throw new AuditWriteError(new Error("disk full"));
      },
      recordInTransaction: async () => {
        throw new AuditWriteError(new Error("disk full"));
      },
    };
    const call = await pendingCall(owner);
    installAuditWriter(failing);
    await expect(
      decideApproval(prisma, {
        approvalId: call.approval.id,
        decider: { type: "human", userId: owner.userId },
        answer: "allow",
        via: "slack",
      }),
    ).rejects.toBeInstanceOf(AuditWriteError);
    expect(await state(call)).toEqual({
      approval: "pending",
      effect: "intended",
      run: "waiting_input",
    });
    const effectsBefore = await prisma.extApproval.count({ where: { spaceId: owner.spaceId } });
    await expect(pendingCall(owner)).rejects.toBeInstanceOf(AuditWriteError);
    expect(await prisma.extApproval.count({ where: { spaceId: owner.spaceId } })).toBe(
      effectsBefore,
    );
  });

  it("lets a call run only with an approved request for its exact hash", async () => {
    const call = await pendingCall(owner, { to: "a@example.test" });
    const hash = approvalCallHash("gmail_send_email", { to: "a@example.test" });
    expect(await checkApprovedCall(prisma, { effectId: call.effect.id, callHash: hash })).toEqual({
      gated: true,
      refusal: expect.stringContaining("not approved"),
    });
    await decideApproval(prisma, {
      approvalId: call.approval.id,
      decider: { type: "human", userId: owner.userId },
      answer: "allow",
      via: "web",
    });
    expect(await checkApprovedCall(prisma, { effectId: call.effect.id, callHash: hash })).toEqual({
      gated: true,
      refusal: null,
    });
    const other = approvalCallHash("gmail_send_email", { to: "b@example.test" });
    expect(
      (await checkApprovedCall(prisma, { effectId: call.effect.id, callHash: other })).refusal,
    ).toContain("different call");
    expect(await checkApprovedCall(prisma, { effectId: "no-such-effect", callHash: hash })).toEqual(
      { gated: false, refusal: null },
    );
  });

  const ownerOrg = async () =>
    (
      await prisma.space.findUniqueOrThrow({
        where: { id: owner.spaceId },
        select: { organizationId: true },
      })
    ).organizationId;
  const leave = async (userId: string) =>
    prisma.member.deleteMany({ where: { organizationId: await ownerOrg(), userId } });
  const rejoin = async (userId: string) =>
    prisma.member.createMany({
      data: [
        {
          id: randomUUID(),
          organizationId: await ownerOrg(),
          userId,
          role: "member",
          createdAt: new Date(),
        },
      ],
      skipDuplicates: true,
    });
  const decideAs = (approvalId: string, userId: string) =>
    decideApproval(prisma, {
      approvalId,
      decider: { type: "human", userId },
      answer: "deny",
      via: "web",
    });

  it("checks the current policy too: an approver taken off the list can no longer decide", async () => {
    await rejoin(memberId);
    await saveApprovalPolicyFor(owner, [owner.userId, memberId]);
    try {
      const call = await pendingCall(owner);
      expect(call.approval.approverIds).toEqual([memberId, owner.userId].sort());
      await saveApprovalPolicyFor(owner, [owner.userId]);
      expect(await decideAs(call.approval.id, memberId)).toMatchObject({
        status: "not_allowed",
        reason: "removed",
      });
      expect((await state(call)).approval).toBe("pending");
      // Nobody on the snapshot is still eligible (the list now names someone else): the sweep
      // closes it.
      await saveApprovalPolicyFor(owner, [other.userId]);
      expect(await findApprovalsToClose(prisma, new Date())).toContainEqual({
        id: call.approval.id,
        reason: "no_approver",
      });
      await saveApprovalPolicyFor(owner, [owner.userId]);
      expect(await decideAs(call.approval.id, owner.userId)).toMatchObject({
        status: "decided",
        outcome: "deny",
      });
    } finally {
      await saveApprovalPolicyFor(owner, []);
    }
  });

  it("restores authority after leaving and rejoining only while still on the policy", async () => {
    await rejoin(memberId);
    await saveApprovalPolicyFor(owner, [memberId]);
    try {
      const kept = await pendingCall(owner);
      await leave(memberId);
      expect(await decideAs(kept.approval.id, memberId)).toMatchObject({ reason: "left" });
      await rejoin(memberId);
      expect(await decideAs(kept.approval.id, memberId)).toMatchObject({ status: "decided" });

      const dropped = await pendingCall(owner);
      await leave(memberId);
      await saveApprovalPolicyFor(owner, [owner.userId]);
      await rejoin(memberId);
      expect(await decideAs(dropped.approval.id, memberId)).toMatchObject({
        status: "not_allowed",
        reason: "removed",
      });
      expect((await state(dropped)).approval).toBe("pending");
      await decideAs(dropped.approval.id, owner.userId);
    } finally {
      await rejoin(memberId);
      await saveApprovalPolicyFor(owner, []);
    }
  });

  it("keys a bot's policy by space and bot for reads and writes alike", async () => {
    await prisma.$transaction((tx) =>
      saveApprovalPolicy(tx, {
        spaceId: other.spaceId,
        botId: owner.botId,
        actorId: other.userId,
        patch: { gatedClasses: ["read"] },
      }),
    );
    expect(
      (await loadApprovalPolicy(prisma, { spaceId: owner.spaceId, botId: owner.botId }))
        .gatedClasses,
    ).toEqual(["write-external"]);
    expect(
      (await loadApprovalPolicy(prisma, { spaceId: other.spaceId, botId: owner.botId }))
        .gatedClasses,
    ).toEqual(["read"]);
    await prisma.extBotApprovalPolicy.deleteMany({
      where: { spaceId: other.spaceId, botId: owner.botId },
    });
  });

  it("reads the whole roster and sweeps every pending request, page by page", async () => {
    await rejoin(memberId);
    const roster = await loadSpaceRoster(prisma, owner.spaceId, { batchSize: 1 });
    expect(roster.members.map((m) => m.userId).sort()).toEqual([owner.userId, memberId].sort());
    await saveApprovalPolicyFor(owner, [memberId]);
    try {
      const older = [await pendingCall(owner), await pendingCall(owner)];
      await saveApprovalPolicyFor(owner, [owner.userId]);
      const newest = await pendingCall(owner);
      await saveApprovalPolicyFor(owner, [memberId]);
      const due = await findApprovalsToClose(prisma, new Date(), { batchSize: 1 });
      expect(due).toContainEqual({ id: newest.approval.id, reason: "no_approver" });
      expect(due).not.toContainEqual(expect.objectContaining({ id: older[0]!.approval.id }));
      for (const call of [...older, newest]) {
        await decideApproval(prisma, {
          approvalId: call.approval.id,
          decider: { type: "system" },
          answer: "deny",
          via: "system",
        });
      }
    } finally {
      await saveApprovalPolicyFor(owner, []);
    }
  });

  it("lets a worker start only with the API's EXT_APPROVALS value", async () => {
    const before = await prisma.deploymentSettings.findUnique({ where: { id: "default" } });
    try {
      await recordApprovalsFlag(prisma, true);
      await expect(assertApprovalsFlag(prisma, true)).resolves.toBeUndefined();
      await expect(assertApprovalsFlag(prisma, false)).rejects.toThrow(
        "EXT_APPROVALS is 0 in the worker but 1 in the API",
      );
      await recordApprovalsFlag(prisma, false);
      await expect(assertApprovalsFlag(prisma, true)).rejects.toThrow(
        "EXT_APPROVALS is 1 in the worker but 0 in the API",
      );
      // Not recorded yet (the API has never started): nothing to compare.
      await prisma.deploymentSettings.update({
        where: { id: "default" },
        data: { extApprovals: null },
      });
      await expect(assertApprovalsFlag(prisma, true)).resolves.toBeUndefined();
    } finally {
      if (before) {
        await prisma.deploymentSettings.update({
          where: { id: "default" },
          data: { extApprovals: before.extApprovals },
        });
      }
    }
  });

  async function saveApprovalPolicyFor(target: Target, approverUserIds: string[]) {
    await prisma.$transaction((tx) =>
      saveApprovalPolicy(tx, {
        spaceId: target.spaceId,
        botId: target.botId,
        actorId: target.userId,
        patch: { approverUserIds },
      }),
    );
  }
});

function pick(target: Target) {
  return {
    spaceId: target.spaceId,
    botId: target.botId,
    threadId: target.threadId,
    userId: target.userId,
  };
}
