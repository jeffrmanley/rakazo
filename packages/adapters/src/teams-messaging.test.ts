import type { KeyObject } from "node:crypto";
import { generateKeyPairSync, sign } from "node:crypto";
import type { MessagingInboundEvent } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, describe, expect, it } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import { messagingPlatformsFromEnv } from "./messaging-platforms.js";

// Fake identifiers; nothing here talks to Azure or Bot Framework.
const appId = "00000000-0000-4000-8000-0000000000a1";
const tenantId = "00000000-0000-4000-8000-0000000000b2";
const otherTenantId = "00000000-0000-4000-8000-0000000000c3";
const appPassword = "test-teams-app-password";
const serviceUrl = "https://smba.trafficmanager.net/teams/";
const userId = "29:test-user";

const trusted = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwt(claims: Record<string, unknown>, key: KeyObject = trusted.privateKey): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "RS256", typ: "JWT", kid: "test-kid" })}.${encode(claims)}`;
  return `${signingInput}.${sign("sha256", Buffer.from(signingInput), key).toString("base64url")}`;
}

/** Bot Framework connector token shape (no tenant claim). */
function botFrameworkToken(overrides: Record<string, unknown> = {}, key?: KeyObject): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt(
    {
      iss: "https://api.botframework.com",
      aud: appId,
      serviceurl: serviceUrl,
      nbf: now - 60,
      exp: now + 3600,
      ...overrides,
    },
    key,
  );
}

interface ActivityOptions {
  conversationType?: "personal" | "groupChat" | "channel";
  conversationTenant?: string | undefined;
  channelTenant?: string | undefined;
  from?: string;
}

function activity(options: ActivityOptions = {}) {
  const conversationType = options.conversationType ?? "personal";
  const conversationTenant =
    "conversationTenant" in options ? options.conversationTenant : tenantId;
  const channelTenant = "channelTenant" in options ? options.channelTenant : tenantId;
  return {
    type: "message",
    id: "1700000000001",
    timestamp: "2026-01-01T00:00:00.000Z",
    serviceUrl,
    channelId: "msteams",
    // No aadObjectId, so the adapter does not call the members API.
    from: { id: options.from ?? userId, name: "Test User" },
    conversation: {
      id: conversationType === "personal" ? "a:personal-test" : "19:group-test@thread.v2",
      conversationType,
      isGroup: conversationType !== "personal",
      ...(conversationTenant ? { tenantId: conversationTenant } : {}),
    },
    recipient: { id: `28:${appId}`, name: "Rakazo" },
    text: "hello",
    textFormat: "plain",
    channelData: {
      ...(channelTenant ? { tenant: { id: channelTenant } } : {}),
      ...(conversationType === "channel"
        ? { team: { id: "19:team-test@thread.tacv2" }, channel: { id: "19:channel-test" } }
        : {}),
    },
  };
}

function webhook(body: unknown, token?: string) {
  return new Request("https://rakazo.test/api/v1/messaging/webhook/teams", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

interface TeamsInternals {
  app: {
    server: {
      serviceTokenValidator?: {
        jwtValidator: {
          getSigningKey: (
            header: unknown,
            callback: (err: Error | null, key?: string) => void,
          ) => void;
        };
      };
    };
  };
}

const surfaces: ChatSdkMessagingSurface[] = [];

async function createSurface() {
  const platforms = messagingPlatformsFromEnv({
    teamsAppId: appId,
    teamsAppPassword: appPassword,
    teamsAppTenantId: tenantId,
  });
  const surface = new ChatSdkMessagingSurface(platforms);
  surfaces.push(surface);
  const events: MessagingInboundEvent[] = [];
  surface.onInbound(async (event) => {
    events.push(event);
  });
  await surface.initialize();
  // Point the SDK's JWKS lookup at the test key. Signature, audience,
  // issuer, expiry, and serviceurl checks all still run in the pinned SDK.
  const validator = (platforms[0]!.adapter as unknown as TeamsInternals).app.server
    .serviceTokenValidator;
  if (!validator) throw new Error("Teams inbound token validation is not initialized");
  const trustedPem = trusted.publicKey.export({ type: "spki", format: "pem" }).toString();
  validator.jwtValidator.getSigningKey = (_header, callback) => callback(null, trustedPem);
  return { surface, events };
}

afterEach(async () => {
  for (const surface of surfaces.splice(0)) await surface.shutdown();
});

describe("Teams messaging conformance", () => {
  describe("inbound authentication", () => {
    it("rejects a webhook without an Authorization header", async () => {
      const { surface, events } = await createSurface();
      const response = await surface.handleWebhook("teams", webhook(activity()));
      expect(response?.status).toBe(401);
      expect(events).toEqual([]);
    });

    it.each([
      ["a malformed token", () => "not-a-jwt"],
      ["a token signed by an unknown key", () => botFrameworkToken({}, stranger.privateKey)],
      ["a token for another bot", () => botFrameworkToken({ aud: "another-app" })],
      ["a token from another issuer", () => botFrameworkToken({ iss: "https://evil.test" })],
      ["an expired token", () => botFrameworkToken({ nbf: 1_000_000_000, exp: 1_000_000_100 })],
      [
        "a token bound to another service URL",
        () => botFrameworkToken({ serviceurl: "https://evil.test/teams/" }),
      ],
    ])("rejects %s", async (_label, token) => {
      const { surface, events } = await createSurface();
      const response = await surface.handleWebhook("teams", webhook(activity(), token()));
      expect(response?.status).toBe(401);
      expect(events).toEqual([]);
    });

    it("does not let a spoofed matching tenant bypass JWT validation", async () => {
      const { surface, events } = await createSurface();
      const response = await surface.handleWebhook(
        "teams",
        webhook(activity({ conversationTenant: tenantId, channelTenant: tenantId })),
      );
      expect(response?.status).toBe(401);
      expect(events).toEqual([]);
    });

    it("returns a generic body on rejection", async () => {
      const { surface } = await createSurface();
      const response = await surface.handleWebhook("teams", webhook(activity(), "not-a-jwt"));
      const body = await response?.text();
      expect(body).not.toContain(appPassword);
      expect(body).not.toMatch(/stack|at .*\.js/i);
    });
  });

  describe("single-tenant restriction", () => {
    it.each([
      ["another tenant", { conversationTenant: otherTenantId, channelTenant: otherTenantId }],
      ["a conversation tenant mismatch", { conversationTenant: otherTenantId }],
      ["a channel-data tenant mismatch", { channelTenant: otherTenantId }],
      ["no tenant at all", { conversationTenant: undefined, channelTenant: undefined }],
    ] as const)("rejects %s even with a valid token", async (_label, options) => {
      const { surface, events } = await createSurface();
      const response = await surface.handleWebhook(
        "teams",
        webhook(activity(options), botFrameworkToken()),
      );
      expect(response?.status).toBe(403);
      expect(await response?.text()).toBe("Forbidden");
      expect(events).toEqual([]);
    });

    it("rejects an Entra-issued token from another tenant", async () => {
      const { surface, events } = await createSurface();
      const now = Math.floor(Date.now() / 1000);
      const token = jwt({
        iss: `https://login.microsoftonline.com/${otherTenantId}/v2.0`,
        tid: otherTenantId,
        aud: appId,
        nbf: now - 60,
        exp: now + 3600,
      });
      const response = await surface.handleWebhook("teams", webhook(activity(), token));
      expect(response?.status).toBe(403);
      expect(events).toEqual([]);
    });

    it("rejects a non-JSON body without reaching the adapter", async () => {
      const { surface, events } = await createSurface();
      const response = await surface.handleWebhook(
        "teams",
        webhook("{not json", botFrameworkToken()),
      );
      expect(response?.status).toBe(403);
      expect(events).toEqual([]);
    });

    it("logs the rejection without the tenant id or credentials", async () => {
      const sink = createTestSink();
      installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
      try {
        const { surface } = await createSurface();
        await surface.handleWebhook(
          "teams",
          webhook(
            activity({ conversationTenant: otherTenantId, channelTenant: otherTenantId }),
            botFrameworkToken(),
          ),
        );
        const logged = JSON.stringify(sink.events);
        expect(logged).toContain("teams webhook rejected");
        expect(logged).toContain(otherTenantId.slice(-4));
        expect(logged).not.toContain(otherTenantId);
        expect(logged).not.toContain(tenantId);
        expect(logged).not.toContain(appPassword);
      } finally {
        installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
      }
    });
  });

  describe("delivery", () => {
    it("delivers an authenticated direct message from the configured tenant", async () => {
      const { surface, events } = await createSurface();
      const response = await surface.handleWebhook(
        "teams",
        webhook(activity(), botFrameworkToken()),
      );
      expect(response?.status).toBeLessThan(300);
      expect(events).toEqual([
        expect.objectContaining({
          type: "message",
          provider: "teams",
          isDirect: true,
          from: userId,
          content: "hello",
          threadId: expect.stringMatching(/^teams:/),
        }),
      ]);
      // No workspace id: Teams must not route into the Slack-bound team-chat bridge.
      expect(events[0]).not.toHaveProperty("workspaceId");
    });

    it("compares tenant ids case-insensitively", async () => {
      const { surface, events } = await createSurface();
      const response = await surface.handleWebhook(
        "teams",
        webhook(
          activity({
            conversationTenant: tenantId.toUpperCase(),
            channelTenant: tenantId.toUpperCase(),
          }),
          botFrameworkToken(),
        ),
      );
      expect(response?.status).toBeLessThan(300);
      expect(events).toHaveLength(1);
    });

    it.each(["groupChat", "channel"] as const)(
      "acknowledges but does not deliver %s messages",
      async (conversationType) => {
        const { surface, events } = await createSurface();
        const response = await surface.handleWebhook(
          "teams",
          webhook(activity({ conversationType }), botFrameworkToken()),
        );
        expect(response?.status).toBeLessThan(300);
        expect(events).toEqual([]);
      },
    );

    it("drops the bot's own messages", async () => {
      const { surface, events } = await createSurface();
      const response = await surface.handleWebhook(
        "teams",
        webhook(activity({ from: `28:${appId}` }), botFrameworkToken()),
      );
      expect(response?.status).toBeLessThan(300);
      expect(events).toEqual([]);
    });

    it("returns a retryable failure when inbound persistence fails", async () => {
      const { surface } = await createSurface();
      surface.onInbound(async () => {
        throw new Error("Persistence unavailable");
      });
      const response = await surface.handleWebhook(
        "teams",
        webhook(activity(), botFrameworkToken()),
      );
      expect(response?.status).toBe(500);
    });
  });
});
