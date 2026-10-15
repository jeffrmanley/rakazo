import type { MessagingCard } from "@rakazo/adapter-kit";
import type { ApprovalRow, PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  createApprovalModule,
  getApprovals,
  installApprovals,
  postApprovalCard,
  refreshApprovalCard,
} from "./ext-approvals.js";

const row: ApprovalRow = {
  id: "appr_1",
  spaceId: "space_a",
  botId: "bot_1",
  runId: "run_1",
  threadId: "thread_1",
  effectId: "effect_1",
  toolName: "destination.write",
  riskClass: "write-external",
  callHash: "h",
  args: { title: "Q3" },
  reason: "Filing the report",
  requestedBy: "user_1",
  approverIds: ["user_1"],
  status: "pending",
  createdAt: new Date("2026-10-15T12:00:00Z"),
  expiresAt: new Date("2026-10-15T12:30:00Z"),
  decidedAt: null,
  decidedBy: null,
  decidedVia: null,
  interactionId: null,
  decisionNote: null,
  cardProvider: null,
  cardThreadId: null,
  cardMessageId: null,
};

type Identity = {
  id: string;
  provider: string;
  address: string;
  dmThreadId: string | null;
  botId: string;
};

function fakePrisma(options: {
  policy?: { gatedClasses: string[]; approverUserIds: string[] } | null;
  runIdentityId?: string | null;
  identities?: Identity[];
  homeId?: string | null;
  approval?: ApprovalRow;
}) {
  let approval = { ...(options.approval ?? row) };
  const identities = options.identities ?? [];
  const prisma = {
    extBotApprovalPolicy: { findFirst: vi.fn(async () => options.policy ?? null) },
    extApproval: {
      findUnique: vi.fn(async () => approval),
      updateMany: vi.fn(async ({ data }: { data: Partial<ApprovalRow> }) => {
        approval = { ...approval, ...data };
        return { count: 1 };
      }),
    },
    run: {
      findUnique: vi.fn(async () => ({
        botId: "bot_1",
        messagingIdentityId: options.runIdentityId ?? null,
      })),
    },
    bot: {
      findUnique: vi.fn(async ({ select }: { select: Record<string, boolean> }) =>
        select.homeMessagingIdentityId
          ? { homeMessagingIdentityId: options.homeId ?? null }
          : { name: "Crew" },
      ),
    },
    messagingIdentity: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string; botId: string } }) =>
        where.id
          ? (identities.find((identity) => identity.id === where.id) ?? null)
          : (identities[0] ?? null),
      ),
    },
    user: { findUnique: vi.fn(async () => ({ name: "Dana" })) },
  };
  return { prisma: prisma as unknown as PrismaClient, current: () => approval };
}

function fakeMessaging(providers = ["slack", "teams"]) {
  const sent: Array<{ threadId: string; card: MessagingCard }> = [];
  const updated: Array<{ threadId: string; handle: string; card: MessagingCard }> = [];
  return {
    sent,
    updated,
    surface: {
      cardProviders: () => providers,
      openDirectThread: vi.fn(async (_provider: string, address: string) => `slack:${address}:`),
      sendCard: vi.fn(async (threadId: string, card: MessagingCard) => {
        sent.push({ threadId, card });
        return { handle: "1700000000.000100" };
      }),
      updateCard: vi.fn(async (threadId: string, handle: string, card: MessagingCard) => {
        updated.push({ threadId, handle, card });
      }),
    },
  };
}

describe("approval gate", () => {
  it("is not installed unless a composition root installs it (flag off)", () => {
    expect(getApprovals()).toBeNull();
    const module = createApprovalModule({ prisma: fakePrisma({}).prisma });
    installApprovals(module);
    expect(getApprovals()).toBe(module);
    installApprovals(null);
    expect(getApprovals()).toBeNull();
  });

  it("gates write-external by default and follows the bot's stored classes", async () => {
    const byDefault = createApprovalModule({ prisma: fakePrisma({}).prisma });
    const call = { spaceId: "s", botId: "b", viaConnector: false };
    expect(await byDefault.gate({ ...call, toolName: "destination.write" })).toBe("write-external");
    expect(await byDefault.gate({ ...call, toolName: "write_file" })).toBeNull();
    expect(await byDefault.gate({ ...call, toolName: "read_file" })).toBeNull();
    expect(await byDefault.gate({ ...call, toolName: "unknown_tool" })).toBe("write-external");

    const internal = createApprovalModule({
      prisma: fakePrisma({ policy: { gatedClasses: ["write-internal"], approverUserIds: [] } })
        .prisma,
    });
    expect(await internal.gate({ ...call, toolName: "write_file" })).toBe("write-internal");
    expect(await internal.gate({ ...call, toolName: "destination.write" })).toBeNull();
  });
});

describe("approval card destination", () => {
  const slackIdentity: Identity = {
    id: "id_slack",
    provider: "slack",
    address: "U1",
    dmThreadId: "slack:D1:",
    botId: "bot_1",
  };
  const teamsHome: Identity = {
    id: "id_teams",
    provider: "teams",
    address: "29:u",
    dmThreadId: "teams:abc:def",
    botId: "bot_1",
  };

  it("posts to the chat app the run came from and records where", async () => {
    const fake = fakePrisma({
      runIdentityId: "id_slack",
      identities: [slackIdentity, teamsHome],
      homeId: "id_teams",
    });
    const messaging = fakeMessaging();
    await postApprovalCard({ prisma: fake.prisma, messaging: messaging.surface }, "appr_1");
    expect(messaging.sent).toEqual([
      expect.objectContaining({
        threadId: "slack:D1:",
        card: expect.objectContaining({ title: "Crew needs approval" }),
      }),
    ]);
    expect(fake.current()).toMatchObject({
      cardProvider: "slack",
      cardThreadId: "slack:D1:",
      cardMessageId: "1700000000.000100",
    });
  });

  it("falls back to the bot's home identity, and stays web only without a card platform", async () => {
    const home = fakePrisma({ identities: [teamsHome], homeId: "id_teams" });
    const messaging = fakeMessaging();
    await postApprovalCard({ prisma: home.prisma, messaging: messaging.surface }, "appr_1");
    expect(messaging.sent.map((sent) => sent.threadId)).toEqual(["teams:abc:def"]);

    const none = fakePrisma({ identities: [] });
    const quiet = fakeMessaging();
    await postApprovalCard({ prisma: none.prisma, messaging: quiet.surface }, "appr_1");
    expect(quiet.sent).toEqual([]);

    const sms = fakePrisma({
      identities: [{ ...slackIdentity, provider: "sendblue" }],
    });
    const noCards = fakeMessaging(["slack", "teams"]);
    await postApprovalCard({ prisma: sms.prisma, messaging: noCards.surface }, "appr_1");
    expect(noCards.sent).toEqual([]);
  });

  it("never fails the run when the card cannot be posted", async () => {
    const fake = fakePrisma({ runIdentityId: "id_slack", identities: [slackIdentity] });
    const messaging = fakeMessaging();
    messaging.surface.sendCard.mockRejectedValueOnce(new Error("slack down"));
    await expect(
      postApprovalCard({ prisma: fake.prisma, messaging: messaging.surface }, "appr_1"),
    ).resolves.toBeUndefined();
    expect(fake.current().cardMessageId).toBeNull();
  });

  it("replaces a decided card with its outcome", async () => {
    const decided: ApprovalRow = {
      ...row,
      status: "deny",
      decidedBy: "user_1",
      cardProvider: "slack",
      cardThreadId: "slack:D1:",
      cardMessageId: "1700000000.000100",
    };
    const fake = fakePrisma({ approval: decided });
    const messaging = fakeMessaging();
    await refreshApprovalCard({ prisma: fake.prisma, messaging: messaging.surface }, decided);
    expect(messaging.updated).toEqual([
      expect.objectContaining({ threadId: "slack:D1:", handle: "1700000000.000100" }),
    ]);
    expect(messaging.updated[0]!.card.actions ?? []).toEqual([]);
    expect(messaging.updated[0]!.card.blocks.at(-1)?.text).toBe("Denied by Dana");
    // A pending request or one without a card is left alone.
    await refreshApprovalCard({ prisma: fake.prisma, messaging: messaging.surface }, row);
    expect(messaging.updated).toHaveLength(1);
  });
});
