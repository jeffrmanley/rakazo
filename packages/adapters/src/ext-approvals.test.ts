import type { MessagingCard } from "@rakazo/adapter-kit";
import type { ApprovalRow, PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  createApprovalModule,
  getApprovals,
  installApprovals,
  pickCardIdentity,
  postApprovalCards,
  refreshApprovalCards,
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
  callHash: "a1b2c3d4".repeat(8),
  args: { title: "Q3" },
  reason: "Filing the report",
  requestedBy: "u_req",
  approverIds: ["u_owner", "u_req", "u_nolink"],
  status: "pending",
  createdAt: new Date("2026-10-15T12:00:00Z"),
  expiresAt: new Date("2026-10-15T12:30:00Z"),
  decidedAt: null,
  decidedBy: null,
  decidedVia: null,
  interactionId: null,
  decisionNote: null,
};

type Identity = {
  id: string;
  userId: string;
  provider: string;
  address: string;
  dmThreadId: string | null;
  botId: string;
  lastInboundAt: Date | null;
  createdAt: Date;
};

const identity = (overrides: Partial<Identity> & Pick<Identity, "id" | "userId">): Identity => ({
  provider: "slack",
  address: `U-${overrides.id}`,
  dmThreadId: `slack:D-${overrides.id}:`,
  botId: "bot_1",
  lastInboundAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

type Card = {
  id: string;
  approvalId: string;
  kind: string;
  userId: string;
  identityId: string;
  provider: string;
  threadId: string;
  messageId: string | null;
  createdAt: Date;
};

function fakePrisma(options: {
  identities: Identity[];
  runIdentityId?: string | null;
  homeId?: string | null;
  approval?: ApprovalRow;
  policy?: { gatedClasses: string[]; approverUserIds: string[] } | null;
  mcpAddedBy?: string | null;
}) {
  let approval = { ...(options.approval ?? row) };
  const cards: Card[] = [];
  const prisma = {
    extBotApprovalPolicy: { findUnique: vi.fn(async () => options.policy ?? null) },
    mcpServer: {
      findFirst: vi.fn(async () =>
        options.mcpAddedBy === undefined ? null : { addedByBotId: options.mcpAddedBy },
      ),
    },
    extApproval: { findUnique: vi.fn(async () => approval) },
    run: {
      findUnique: vi.fn(async () => ({
        botId: "bot_1",
        messagingIdentityId: options.runIdentityId ?? null,
      })),
    },
    bot: {
      findUnique: vi.fn(async () => ({
        name: "Crew",
        homeMessagingIdentityId: options.homeId ?? null,
      })),
    },
    messagingIdentity: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          options.identities.find((each) => each.id === where.id) ?? null,
      ),
      findMany: vi.fn(
        async ({ where }: { where: { userId: string; provider?: { in: string[] } } }) =>
          options.identities.filter(
            (each) =>
              each.userId === where.userId &&
              (!where.provider || where.provider.in.includes(each.provider)),
          ),
      ),
    },
    extApprovalCard: {
      createMany: vi.fn(async ({ data }: { data: Card[] }) => {
        const [card] = data;
        if (
          cards.some((c) => c.approvalId === card!.approvalId && c.identityId === card!.identityId)
        ) {
          return { count: 0 };
        }
        cards.push({ ...card!, messageId: null, createdAt: new Date() });
        return { count: 1 };
      }),
      findMany: vi.fn(async () => cards),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Card> }) => {
        const card = cards.find((c) => c.id === where.id)!;
        Object.assign(card, data);
        return card;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        cards.splice(
          cards.findIndex((c) => c.id === where.id),
          1,
        );
      }),
    },
    user: { findUnique: vi.fn(async () => ({ name: "Dana" })) },
  };
  return {
    prisma: prisma as unknown as PrismaClient,
    cards,
    decide: (status: string) => {
      approval = { ...approval, status, decidedBy: "u_owner" };
      return approval;
    },
  };
}

function fakeMessaging(providers = ["slack", "teams"]) {
  const sent: Array<{ threadId: string; card: MessagingCard }> = [];
  const texts: Array<{ threadId: string; body: string }> = [];
  const updated: Array<{ threadId: string; handle: string; card: MessagingCard }> = [];
  let counter = 0;
  return {
    sent,
    texts,
    updated,
    surface: {
      cardProviders: () => providers,
      openDirectThread: vi.fn(async (_provider: string, address: string) => `slack:${address}:`),
      sendCard: vi.fn(async (threadId: string, card: MessagingCard) => {
        sent.push({ threadId, card });
        counter += 1;
        return { handle: `ts-${counter}` };
      }),
      sendToThread: vi.fn(async (request: { threadId: string; body: string }) => {
        texts.push(request);
        return { handle: "notice" };
      }),
      updateCard: vi.fn(async (threadId: string, handle: string, card: MessagingCard) => {
        updated.push({ threadId, handle, card });
      }),
    },
  };
}

describe("approval gate", () => {
  const call = { spaceId: "s", botId: "b", viaConnector: false };

  it("is not installed unless a composition root installs it (flag off)", () => {
    expect(getApprovals()).toBeNull();
    const module = createApprovalModule({ prisma: fakePrisma({ identities: [] }).prisma });
    installApprovals(module);
    expect(getApprovals()).toBe(module);
    installApprovals(null);
    expect(getApprovals()).toBeNull();
  });

  it("gates write-external by default and follows the bot's stored classes", async () => {
    const byDefault = createApprovalModule({ prisma: fakePrisma({ identities: [] }).prisma });
    expect(await byDefault.gate({ ...call, toolName: "destination.write" })).toBe("write-external");
    expect(await byDefault.gate({ ...call, toolName: "message_bot" })).toBe("write-external");
    expect(await byDefault.gate({ ...call, toolName: "write_file" })).toBeNull();
    expect(await byDefault.gate({ ...call, toolName: "unknown_tool" })).toBe("write-external");

    const internal = createApprovalModule({
      prisma: fakePrisma({
        identities: [],
        policy: { gatedClasses: ["write-internal"], approverUserIds: [] },
      }).prisma,
    });
    expect(await internal.gate({ ...call, toolName: "write_file" })).toBe("write-internal");
    expect(await internal.gate({ ...call, toolName: "destination.write" })).toBeNull();
  });

  it("gates reads when Reads is on, but never the conversation tools", async () => {
    const reads = createApprovalModule({
      prisma: fakePrisma({
        identities: [],
        policy: { gatedClasses: ["read"], approverUserIds: [] },
      }).prisma,
    });
    expect(await reads.gate({ ...call, toolName: "read_file" })).toBe("read");
    expect(await reads.gate({ ...call, toolName: "web_fetch" })).toBe("read");
    for (const toolName of ["ask_user", "end_call", "request_takeover", "request_secret"]) {
      expect(await reads.gate({ ...call, toolName })).toBeNull();
    }
  });

  it("treats every tool of an MCP server the model added as write-external", async () => {
    const tool = { ...call, toolName: "mcp__fixture__list_items", viaConnector: true };
    const added = createApprovalModule({
      prisma: fakePrisma({ identities: [], mcpAddedBy: "bot_9" }).prisma,
    });
    expect(await added.gate({ ...tool, mcpServerId: "srv_1" })).toBe("write-external");
    const human = createApprovalModule({
      prisma: fakePrisma({ identities: [], mcpAddedBy: null }).prisma,
    });
    expect(await human.gate({ ...tool, mcpServerId: "srv_1" })).toBeNull();
  });
});

describe("which chat identity gets an approver's card", () => {
  const providers = ["slack", "teams"];

  it("prefers the run's own chat for the requester, then the bot's home, then this bot, then the latest", () => {
    const runIdentity = identity({ id: "run", userId: "u_req", provider: "teams" });
    const home = identity({ id: "home", userId: "u_req" });
    const thisBot = identity({ id: "bot", userId: "u_owner" });
    const otherBot = identity({
      id: "other",
      userId: "u_owner",
      botId: "bot_2",
      lastInboundAt: new Date("2026-10-01T00:00:00Z"),
    });
    const ctx = { botId: "bot_1", homeId: "home", runIdentity, requesterId: "u_req", providers };
    expect(pickCardIdentity([home, runIdentity], { ...ctx, userId: "u_req" })?.id).toBe("run");
    expect(pickCardIdentity([home], { ...ctx, runIdentity: null, userId: "u_req" })?.id).toBe(
      "home",
    );
    expect(pickCardIdentity([otherBot, thisBot], { ...ctx, userId: "u_owner" })?.id).toBe("bot");
    expect(pickCardIdentity([otherBot], { ...ctx, userId: "u_owner" })?.id).toBe("other");
    expect(
      pickCardIdentity([identity({ id: "sms", userId: "u_owner", provider: "sendblue" })], {
        ...ctx,
        userId: "u_owner",
      }),
    ).toBeNull();
  });
});

describe("approval cards", () => {
  const identities = [
    identity({ id: "id_owner", userId: "u_owner" }),
    identity({ id: "id_req", userId: "u_req", provider: "teams", dmThreadId: "teams:req" }),
  ];

  it("posts one card to each approver with a linked identity and skips the others", async () => {
    const fake = fakePrisma({ identities, runIdentityId: "id_req" });
    const messaging = fakeMessaging();
    await postApprovalCards({ prisma: fake.prisma, messaging: messaging.surface }, "appr_1");
    expect(messaging.sent.map((sent) => sent.threadId).sort()).toEqual(
      ["slack:D-id_owner:", "teams:req"].sort(),
    );
    expect(messaging.sent[0]!.card.title).toBe("Crew needs approval");
    expect(fake.cards.map((card) => [card.userId, card.kind, card.messageId])).toEqual(
      expect.arrayContaining([
        ["u_owner", "approval", expect.stringMatching(/^ts-/)],
        ["u_req", "approval", expect.stringMatching(/^ts-/)],
      ]),
    );
    expect(messaging.texts).toEqual([]);
    // Announced again (a resumed run asks again): nothing is posted twice.
    await postApprovalCards({ prisma: fake.prisma, messaging: messaging.surface }, "appr_1");
    expect(messaging.sent).toHaveLength(2);
  });

  it("tells a requester who is not an approver that the call waits", async () => {
    const fake = fakePrisma({
      identities,
      runIdentityId: "id_req",
      approval: { ...row, approverIds: ["u_owner"] },
    });
    const messaging = fakeMessaging();
    await postApprovalCards({ prisma: fake.prisma, messaging: messaging.surface }, "appr_1");
    expect(messaging.sent.map((sent) => sent.threadId)).toEqual(["slack:D-id_owner:"]);
    expect(messaging.texts).toEqual([
      expect.objectContaining({
        threadId: "teams:req",
        body: "Crew is waiting for approval to run destination.write.",
      }),
    ]);
  });

  it("never fails the run when a card cannot be posted, and frees it for a retry", async () => {
    const fake = fakePrisma({ identities, runIdentityId: "id_req" });
    const messaging = fakeMessaging();
    messaging.surface.sendCard.mockRejectedValueOnce(new Error("slack down"));
    await expect(
      postApprovalCards({ prisma: fake.prisma, messaging: messaging.surface }, "appr_1"),
    ).resolves.toBeUndefined();
    expect(fake.cards).toHaveLength(1);
  });

  it("updates every approver's card with the outcome", async () => {
    const fake = fakePrisma({ identities, runIdentityId: "id_req" });
    const messaging = fakeMessaging();
    await postApprovalCards({ prisma: fake.prisma, messaging: messaging.surface }, "appr_1");
    const decided = fake.decide("deny");
    await refreshApprovalCards({ prisma: fake.prisma, messaging: messaging.surface }, decided);
    expect(messaging.updated).toHaveLength(2);
    for (const update of messaging.updated) {
      expect(update.card.actions ?? []).toEqual([]);
      expect(update.card.blocks.at(-1)?.text).toBe("Denied by Dana");
    }
    // A pending request is left alone.
    await refreshApprovalCards({ prisma: fake.prisma, messaging: messaging.surface }, row);
    expect(messaging.updated).toHaveLength(2);
  });
});
