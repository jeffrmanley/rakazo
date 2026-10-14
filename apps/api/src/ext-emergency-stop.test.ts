import type { MessagingCommand, MessagingInboundMessage } from "@rakazo/adapter-kit";
import type { ActiveStop, EmergencyStopReader, PrismaClient } from "@rakazo/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlPrincipal, ControlService } from "./ext-emergency-stop.js";
import {
  authorizeControl,
  CONTROL_API_PATHS,
  ControlError,
  createChatControl,
  mountControlRoutes,
  parseControlBody,
  resolveControlTarget,
} from "./ext-emergency-stop.js";

const owner: ControlPrincipal = { userId: "owner-a", spaceId: "space-a", isDeploymentOwner: false };
const member: ControlPrincipal = {
  userId: "member-a",
  spaceId: "space-a",
  isDeploymentOwner: false,
};
const deploymentOwner: ControlPrincipal = {
  userId: "admin",
  spaceId: "space-admin",
  isDeploymentOwner: true,
};
const otherOwner: ControlPrincipal = {
  userId: "owner-b",
  spaceId: "space-b",
  isDeploymentOwner: false,
};

const roles: Record<string, string> = {
  "space-a:owner-a": "owner",
  "space-a:member-a": "member",
  "space-admin:admin": "owner",
  "space-b:owner-b": "owner",
  // The deployment owner is a plain member of space A.
  "space-a:admin": "member",
};
const bots = [
  { id: "bot-a1", spaceId: "space-a", name: "Alice", archivedAt: null },
  { id: "bot-b1", spaceId: "space-b", name: "Bob", archivedAt: null },
];

function fakePrisma() {
  return {
    spaceMember: {
      findUnique: vi.fn(
        async ({ where }: { where: { spaceId_userId: { spaceId: string; userId: string } } }) => {
          const role = roles[`${where.spaceId_userId.spaceId}:${where.spaceId_userId.userId}`];
          return role ? { role } : null;
        },
      ),
    },
    bot: {
      findFirst: vi.fn(
        async ({ where }: { where: { id?: string; spaceId: string; name?: { equals: string } } }) =>
          bots.find(
            (bot) =>
              bot.spaceId === where.spaceId &&
              (where.id === undefined || bot.id === where.id) &&
              (where.name === undefined ||
                bot.name.toLowerCase() === where.name.equals.toLowerCase()),
          ) ?? null,
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          bots.find((bot) => bot.id === where.id) ?? null,
      ),
    },
    messagingIdentity: {
      findUnique: vi.fn(async () => null as unknown),
    },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({ ownerUserId: "admin" })),
    },
    user: {
      findUnique: vi.fn(async () => ({ name: "Dana Owner" })),
    },
  };
}

const logged = vi.hoisted(() => ({ warn: [] as unknown[][], error: [] as unknown[][] }));
vi.mock("@rakazo/logging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/logging")>();
  return {
    ...actual,
    getLogger: () => ({
      ...actual.getLogger(),
      warn: (...args: unknown[]) => logged.warn.push(args),
      error: (...args: unknown[]) => logged.error.push(args),
      info: () => undefined,
    }),
  };
});

afterEach(() => {
  logged.warn.length = 0;
  logged.error.length = 0;
});

describe("authorizeControl", () => {
  const cases: Array<[string, ControlPrincipal, "bot" | "space" | "global", boolean]> = [
    ["space owner, bot", owner, "bot", true],
    ["space owner, space", owner, "space", true],
    ["space owner, global", owner, "global", false],
    ["plain member, bot", member, "bot", false],
    ["plain member, space", member, "space", false],
    ["plain member, global", member, "global", false],
    ["deployment owner in own space, space", deploymentOwner, "space", true],
    ["deployment owner, global", deploymentOwner, "global", true],
    [
      "deployment owner who is a plain member here, space",
      { ...deploymentOwner, spaceId: "space-a" },
      "space",
      false,
    ],
    ["other space's owner, own space", otherOwner, "space", true],
  ];
  for (const [name, principal, scope, allowed] of cases) {
    it(`${allowed ? "allows" : "denies"} ${name}`, async () => {
      const prisma = fakePrisma();
      const result = authorizeControl(prisma as unknown as PrismaClient, principal, scope);
      if (allowed) {
        await expect(result).resolves.toBeUndefined();
        expect(logged.warn).toHaveLength(0);
      } else {
        await expect(result).rejects.toMatchObject({ status: 403 });
        // Every denial is logged server-side with who and what, never secrets.
        expect(logged.warn).toHaveLength(1);
        expect(logged.warn[0]?.[1]).toMatchObject({
          "user.id": principal.userId,
          "space.id": principal.spaceId,
          "control.scope": scope,
        });
      }
    });
  }

  it("denies when the membership lookup finds nothing (default deny)", async () => {
    const prisma = fakePrisma();
    await expect(
      authorizeControl(
        prisma as unknown as PrismaClient,
        { userId: "stranger", spaceId: "space-a", isDeploymentOwner: false },
        "bot",
      ),
    ).rejects.toBeInstanceOf(ControlError);
  });
});

describe("resolveControlTarget", () => {
  it("scopes a bot to the session space and hides other spaces' bots", async () => {
    const prisma = fakePrisma() as unknown as PrismaClient;
    await expect(
      resolveControlTarget(prisma, owner, { scope: "bot", botId: "bot-a1", reason: "r" }),
    ).resolves.toEqual({ scope: "bot", spaceId: "space-a", botId: "bot-a1", botName: "Alice" });
    // Another space's bot is "not found", exactly like a bot that does not exist.
    const foreign = resolveControlTarget(prisma, owner, {
      scope: "bot",
      botId: "bot-b1",
      reason: "r",
    });
    await expect(foreign).rejects.toMatchObject({ status: 404, message: "Not found" });
    const missing = resolveControlTarget(prisma, owner, {
      scope: "bot",
      botId: "nope",
      reason: "r",
    });
    await expect(missing).rejects.toMatchObject({ status: 404, message: "Not found" });
  });

  it("uses the session space for space scope and no space for global", async () => {
    const prisma = fakePrisma() as unknown as PrismaClient;
    await expect(
      resolveControlTarget(prisma, owner, { scope: "space", reason: "r" }),
    ).resolves.toEqual({ scope: "space", spaceId: "space-a", botId: null, botName: null });
    await expect(
      resolveControlTarget(prisma, deploymentOwner, { scope: "global", reason: "r" }),
    ).resolves.toEqual({ scope: "global", spaceId: null, botId: null, botName: null });
  });
});

describe("parseControlBody", () => {
  it("accepts the spec shape and drops any spaceId", () => {
    expect(
      parseControlBody({ scope: "bot", botId: "bot-1", reason: " runaway ", spaceId: "x" }),
    ).toEqual({ scope: "bot", botId: "bot-1", reason: "runaway" });
    expect(parseControlBody({ scope: "space", reason: "r" })).toEqual({
      scope: "space",
      reason: "r",
    });
  });

  it("rejects malformed bodies", () => {
    expect(parseControlBody(null)).toHaveProperty("error");
    expect(parseControlBody({ scope: "everything", reason: "r" })).toHaveProperty("error");
    expect(parseControlBody({ scope: "bot", reason: "r" })).toHaveProperty("error");
    expect(parseControlBody({ scope: "space", reason: "" })).toHaveProperty("error");
    expect(parseControlBody({ scope: "space" })).toHaveProperty("error");
    expect(parseControlBody({ scope: "space", reason: "x".repeat(501) })).toHaveProperty("error");
  });
});

describe("control routes", () => {
  function mount(principal: ControlPrincipal | null = owner) {
    const service: ControlService = {
      stop: vi.fn(async () => ({
        stop: {
          id: "stop-1",
          scope: "space" as const,
          botId: null,
          reason: "r",
          stoppedAt: "2026-10-15T10:00:00.000Z",
          stoppedBy: { id: "owner-a", name: "Dana Owner" },
        },
      })),
      resume: vi.fn(async () => ({ resumed: 1 })),
      state: vi.fn(async () => ({ canControl: true, canControlGlobal: false, stops: [] })),
    };
    const app = new Hono();
    mountControlRoutes(app, { service, authenticate: async () => principal });
    return { app, service };
  }
  const post = (app: Hono, path: string, body: unknown, query = "") =>
    app.request(`${path}${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("exposes the exact REST paths", () => {
    expect(CONTROL_API_PATHS).toEqual({
      stop: "/api/v1/control/stop",
      resume: "/api/v1/control/resume",
      state: "/api/v1/control/state",
    });
  });

  it("requires a session", async () => {
    const { app, service } = mount(null);
    expect((await post(app, CONTROL_API_PATHS.stop, { scope: "space", reason: "r" })).status).toBe(
      401,
    );
    expect((await app.request(CONTROL_API_PATHS.state)).status).toBe(401);
    expect(service.stop).not.toHaveBeenCalled();
    expect(logged.warn).toHaveLength(2);
  });

  it("ignores a spaceId in the body and in the query", async () => {
    const { app, service } = mount();
    const res = await post(
      app,
      CONTROL_API_PATHS.stop,
      { scope: "space", reason: "r", spaceId: "space-b" },
      "?spaceId=space-b&space_id=space-b",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(service.stop).toHaveBeenCalledWith(owner, { scope: "space", reason: "r" });
    const resumed = await post(
      app,
      CONTROL_API_PATHS.resume,
      { scope: "bot", botId: "bot-a1", reason: "r", spaceId: "space-b" },
      "?spaceId=space-b",
    );
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({ resumed: 1 });
    expect(service.resume).toHaveBeenCalledWith(owner, {
      scope: "bot",
      botId: "bot-a1",
      reason: "r",
    });
    await app.request(`${CONTROL_API_PATHS.state}?spaceId=space-b`);
    expect(service.state).toHaveBeenCalledWith(owner);
  });

  it("answers 400 for a malformed body", async () => {
    const { app, service } = mount();
    const res = await app.request(CONTROL_API_PATHS.stop, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    // A form post (no JSON content type) is refused before the body is read.
    const form = await app.request(CONTROL_API_PATHS.stop, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ scope: "space", reason: "r" }),
    });
    expect(form.status).toBe(415);
    expect((await post(app, CONTROL_API_PATHS.stop, { scope: "bot", reason: "r" })).status).toBe(
      400,
    );
    expect(service.stop).not.toHaveBeenCalled();
  });

  it("maps a refusal to its status without detail", async () => {
    const { app, service } = mount();
    (service.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ControlError(403, "Forbidden"),
    );
    const res = await post(app, CONTROL_API_PATHS.stop, { scope: "global", reason: "r" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
  });

  it("hides unexpected failures behind an error id", async () => {
    const { app, service } = mount();
    (service.resume as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("relation ext_control_stops is locked by pid 42"),
    );
    const res = await post(app, CONTROL_API_PATHS.resume, { scope: "space", reason: "r" });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; error_id: string };
    expect(body.error).toBe("Internal error");
    expect(body.error_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toContain("pid 42");
    expect(logged.error[0]?.[2]).toMatchObject({ "error.id": body.error_id });
  });
});

describe("chat control", () => {
  const stopped: ActiveStop = {
    id: "stop-1",
    scope: "bot",
    spaceId: "space-a",
    botId: "bot-a1",
    reason: "r",
    stoppedBy: "owner-a",
    stoppedAt: new Date("2026-10-15T09:05:00Z"),
  };

  function event(overrides: Partial<MessagingInboundMessage>): MessagingInboundMessage {
    return {
      type: "message",
      provider: "slack",
      handle: "h-1",
      threadId: "slack:C1:1",
      isDirect: true,
      from: "U-owner",
      fromLabel: "Dana",
      channelName: null,
      participants: [],
      content: "/stop Alice",
      mediaUrl: null,
      ...overrides,
    };
  }

  function setup(
    options: {
      identity?: { userId: string; spaceId: string; botId: string } | null;
      stop?: ActiveStop | null;
      teamChatBotId?: string | null;
    } = {},
  ) {
    const prisma = fakePrisma();
    const identity =
      options.identity === undefined
        ? { userId: "owner-a", spaceId: "space-a", botId: "bot-a1" }
        : options.identity;
    prisma.messagingIdentity.findUnique.mockResolvedValue(identity);
    const reader: EmergencyStopReader = {
      check: vi.fn(async () => options.stop ?? null),
      activeStops: vi.fn(async () => []),
      invalidate: vi.fn(),
    };
    const sent: Array<{ threadId: string; body: string }> = [];
    const service: ControlService = {
      stop: vi.fn(async () => ({
        stop: {
          id: "stop-1",
          scope: "bot" as const,
          botId: "bot-a1",
          reason: "r",
          stoppedAt: "2026-10-15T10:00:00.000Z",
          stoppedBy: { id: "owner-a", name: "Dana Owner" },
        },
      })),
      resume: vi.fn(async () => ({ resumed: 1 })),
      state: vi.fn(),
    };
    const chat = createChatControl({
      prisma: prisma as unknown as PrismaClient,
      reader,
      service,
      messaging: {
        sendToThread: vi.fn(async (request: { threadId: string; body: string }) => {
          sent.push({ threadId: request.threadId, body: request.body });
          return { handle: "sent" };
        }),
      },
      teamChatBotFor: () => options.teamChatBotId ?? null,
    });
    return { chat, sent, service, reader, prisma };
  }

  it("lets a linked space owner stop and resume a bot by name, case-insensitively", async () => {
    const { chat, sent, service } = setup();
    await expect(chat.intercept(event({ content: "/stop alice" }))).resolves.toBe(true);
    expect(service.stop).toHaveBeenCalledWith(
      { userId: "owner-a", spaceId: "space-a", isDeploymentOwner: false },
      expect.objectContaining({ scope: "bot", botId: "bot-a1" }),
    );
    expect(sent).toEqual([{ threadId: "slack:C1:1", body: "Stopped Alice." }]);

    await chat.intercept(event({ content: "/resume Alice", handle: "h-2" }));
    expect(service.resume).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: "space-a" }),
      expect.objectContaining({ scope: "bot", botId: "bot-a1" }),
    );
    expect(sent[1]?.body).toBe("Resumed Alice.");
  });

  it("stops and resumes the whole space without a name, in a channel too", async () => {
    const { chat, sent, service } = setup();
    await chat.intercept(event({ content: "/stop", isDirect: false, threadId: "slack:C2:9" }));
    expect(service.stop).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "space" }),
    );
    expect(sent[0]).toEqual({ threadId: "slack:C2:9", body: "Stopped every bot in this space." });
    await chat.intercept(event({ content: "/resume" }));
    expect(sent[1]?.body).toBe("Resumed this space.");
  });

  it("refuses a plain member and an unlinked sender, and changes nothing", async () => {
    const plain = setup({ identity: { userId: "member-a", spaceId: "space-a", botId: "bot-a1" } });
    await expect(plain.chat.intercept(event({}))).resolves.toBe(true);
    expect(plain.service.stop).not.toHaveBeenCalled();
    expect(plain.sent[0]?.body).toBe("Only an owner of this space can do that.");

    const stranger = setup({ identity: null });
    await expect(stranger.chat.intercept(event({}))).resolves.toBe(true);
    expect(stranger.service.stop).not.toHaveBeenCalled();
    expect(stranger.sent[0]?.body).toBe("Only an owner of this space can do that.");
    expect(logged.warn.length).toBeGreaterThanOrEqual(2);
  });

  it("never matches a bot from another space", async () => {
    const { chat, sent, service } = setup();
    await chat.intercept(event({ content: "/stop Bob" }));
    expect(service.stop).not.toHaveBeenCalled();
    expect(sent[0]?.body).toBe('No bot named "Bob" here.');
  });

  it("ignores commands from other bots", async () => {
    const { chat, service } = setup();
    await expect(chat.intercept(event({ senderIsBot: true }))).resolves.toBe(false);
    expect(service.stop).not.toHaveBeenCalled();
  });

  it("swallows a bot's command-shaped message to a stopped bot like any other message", async () => {
    const { chat, service } = setup({ stop: stopped, teamChatBotId: "bot-a1" });
    await expect(
      chat.intercept(event({ senderIsBot: true, isDirect: false, kind: "mention" })),
    ).resolves.toBe(true);
    expect(service.stop).not.toHaveBeenCalled();
  });

  it("answers a message to a stopped bot with the paused reply and no run", async () => {
    const { chat, sent, reader } = setup({ stop: stopped });
    await expect(chat.intercept(event({ content: "hello there" }))).resolves.toBe(true);
    expect(reader.check).toHaveBeenCalledWith({ spaceId: "space-a", botId: "bot-a1" });
    expect(sent).toEqual([
      { threadId: "slack:C1:1", body: "Paused by Dana Owner at 2026-10-15 09:05 UTC" },
    ]);
  });

  it("lets ordinary messages and owner YES/NO replies through to a running bot", async () => {
    const running = setup();
    await expect(running.chat.intercept(event({ content: "hello there" }))).resolves.toBe(false);
    const paused = setup({ stop: stopped });
    await expect(paused.chat.intercept(event({ content: "YES" }))).resolves.toBe(false);
    expect(paused.sent).toHaveLength(0);
  });

  it("covers the team-chat bot: replies to mentions, stays silent on ambient talk", async () => {
    const { chat, sent, reader } = setup({ stop: stopped, teamChatBotId: "bot-a1" });
    await expect(
      chat.intercept(event({ isDirect: false, content: "@crew status?", kind: "mention" })),
    ).resolves.toBe(true);
    expect(reader.check).toHaveBeenCalledWith({ spaceId: "space-a", botId: "bot-a1" });
    expect(sent).toHaveLength(1);
    await expect(
      chat.intercept(event({ isDirect: false, content: "lunch?", kind: "ambient" })),
    ).resolves.toBe(true);
    expect(sent).toHaveLength(1);
  });

  describe("Slack slash commands", () => {
    function command(overrides: Partial<MessagingCommand> = {}) {
      const replies: string[] = [];
      const value: MessagingCommand = {
        provider: "slack",
        command: "/stop",
        text: "",
        from: "U-owner",
        threadId: "slack:C1",
        handle: "trigger-1",
        respond: vi.fn(async (body: string) => {
          replies.push(body);
        }),
        ...overrides,
      };
      return { value, replies };
    }

    it("lets a linked owner stop a bot with /stop <bot> and replies only to them", async () => {
      const { chat, sent, service, prisma } = setup();
      const { value, replies } = command({ text: "alice" });
      await chat.handleCommand(value);
      expect(prisma.messagingIdentity.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { provider_address: { provider: "slack", address: "U-owner" } },
        }),
      );
      expect(service.stop).toHaveBeenCalledWith(
        { userId: "owner-a", spaceId: "space-a", isDeploymentOwner: false },
        expect.objectContaining({ scope: "bot", botId: "bot-a1", reason: "/stop from slack" }),
      );
      expect(replies).toEqual(["Stopped Alice."]);
      // Ephemeral reply only: nothing is posted into the channel.
      expect(sent).toHaveLength(0);
    });

    it("resumes the space with a bare /resume", async () => {
      const { chat, service } = setup();
      const { value, replies } = command({ command: "/resume" });
      await chat.handleCommand(value);
      expect(service.resume).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ scope: "space" }),
      );
      expect(replies).toEqual(["Resumed this space."]);
    });

    it("refuses a plain member or an unlinked Slack user without changing anything", async () => {
      const plain = setup({
        identity: { userId: "member-a", spaceId: "space-a", botId: "bot-a1" },
      });
      const first = command();
      await plain.chat.handleCommand(first.value);
      expect(plain.service.stop).not.toHaveBeenCalled();
      expect(first.replies).toEqual(["Only an owner of this space can do that."]);

      const stranger = setup({ identity: null });
      const second = command();
      await stranger.chat.handleCommand(second.value);
      expect(stranger.service.stop).not.toHaveBeenCalled();
      expect(second.replies).toEqual(["Only an owner of this space can do that."]);
    });

    it("ignores commands it does not own", async () => {
      const { chat, service } = setup();
      const { value, replies } = command({ command: "/weather" });
      await chat.handleCommand(value);
      expect(service.stop).not.toHaveBeenCalled();
      expect(replies).toEqual([]);
    });
  });
});
