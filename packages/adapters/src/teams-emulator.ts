import type { KeyObject } from "node:crypto";
import { generateKeyPairSync, randomInt, sign } from "node:crypto";
import type { MessagingPlatform } from "./chat-sdk-surface.js";
import { messagingPlatformsFromEnv } from "./messaging-platforms.js";

export interface TeamsEmulatorInbound {
  conversationType?: "personal" | "groupChat" | "channel";
  /** Teams conversation id; channel threads carry `;messageid=<root id>`. */
  conversationId?: string;
  from?: string;
  fromName?: string;
  text: string;
  /** Add a mention entity for the bot account (the @mention case). */
  mentionBot?: boolean;
  handle?: string;
}

export interface TeamsEmulatorSentActivity {
  conversationId: string;
  text: string;
  textFormat: string | undefined;
  /** Adaptive Card attachments of a card post. */
  attachments?: unknown[];
}

export interface TeamsEmulatorInvoke {
  /** The clicking user's Teams id, as the validated activity carries it. */
  from: string;
  actionId: string;
  value: string;
  conversationId?: string;
  /** The card's activity id. */
  replyToId?: string;
  /** Activity id of the invoke itself (a retry repeats it). */
  handle?: string;
}

/** Pinned-SDK internals the emulator reaches into (same as the conformance tests). */
interface TeamsInternals {
  app: {
    send: (conversationId: string, activity: unknown) => Promise<{ id?: string }>;
    api: {
      conversations: {
        activities: (conversationId: string) => {
          update: (activityId: string, activity: unknown) => Promise<{ id?: string }>;
        };
      };
    };
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
  initialize: (chat: unknown) => Promise<void>;
}

/**
 * Deterministic Microsoft Teams stand-in for CI: the real pinned adapter and
 * SDK verify locally signed Bot Framework tokens against a test key, and
 * outbound activities are recorded instead of posted to Bot Connector.
 */
export class TeamsEmulator {
  readonly appId = "00000000-0000-4000-8000-0000000000a1";
  readonly tenantId = "00000000-0000-4000-8000-0000000000b2";
  readonly appPassword = "emulated-teams-app-password";
  readonly serviceUrl = "https://smba.trafficmanager.net/emulated/";
  readonly botAccountId = `28:${this.appId}`;
  readonly sent: TeamsEmulatorSentActivity[] = [];
  /** Activities replaced through Bot Connector (card updates). */
  readonly updated: Array<{ conversationId: string; activityId: string; attachments?: unknown[] }> =
    [];
  private readonly key: { privateKey: KeyObject; publicKey: KeyObject };
  private counter = 0;

  constructor() {
    this.key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  }

  /** The production Teams platform with recorded sends and the test signing key trusted. */
  createPlatform(): MessagingPlatform {
    const platform = messagingPlatformsFromEnv({
      teamsAppId: this.appId,
      teamsAppPassword: this.appPassword,
      teamsAppTenantId: this.tenantId,
    })[0];
    if (platform?.provider !== "teams") throw new Error("Teams platform not built");
    const internals = platform.adapter as unknown as TeamsInternals;
    const initialize = internals.initialize.bind(platform.adapter);
    internals.initialize = async (chat: unknown) => {
      await initialize(chat);
      // Point the SDK's JWKS lookup at the test key: signature, audience,
      // issuer, expiry and serviceurl checks still run in the pinned SDK.
      const validator = internals.app.server.serviceTokenValidator;
      if (!validator) throw new Error("Teams inbound token validation is not initialized");
      const pem = this.key.publicKey.export({ type: "spki", format: "pem" }).toString();
      validator.jwtValidator.getSigningKey = (_header, callback) => callback(null, pem);
    };
    internals.app.send = async (conversationId, activity) => {
      const record = activity as { text?: string; textFormat?: string; attachments?: unknown[] };
      this.sent.push({
        conversationId,
        text: record.text ?? "",
        textFormat: record.textFormat,
        ...(record.attachments?.length ? { attachments: record.attachments } : {}),
      });
      this.counter += 1;
      return { id: `sent-${this.counter}` };
    };
    internals.app.api.conversations.activities = (conversationId) => ({
      update: async (activityId, activity) => {
        const record = activity as { attachments?: unknown[] };
        this.updated.push({ conversationId, activityId, attachments: record.attachments });
        return { id: activityId };
      },
    });
    return platform;
  }

  /** The adapter's thread id for a conversation of this emulated tenant. */
  threadId(conversationId: string): string {
    const encode = (value: string) => Buffer.from(value).toString("base64url");
    return `teams:${encode(conversationId)}:${encode(this.serviceUrl)}`;
  }

  /** A signed Adaptive Card button click (invoke `adaptiveCard/action`). */
  buildInvokeRequest(input: TeamsEmulatorInvoke, token = this.token()): Request {
    const conversationId = input.conversationId ?? "a:emulated-personal";
    const activity = {
      type: "invoke",
      name: "adaptiveCard/action",
      id: input.handle ?? `invoke-${1700000000000 + randomInt(1_000_000_000)}`,
      timestamp: new Date().toISOString(),
      serviceUrl: this.serviceUrl,
      channelId: "msteams",
      from: { id: input.from, name: "Test User" },
      conversation: {
        id: conversationId,
        conversationType: "personal",
        isGroup: false,
        tenantId: this.tenantId,
      },
      recipient: { id: this.botAccountId, name: "Rakazo" },
      ...(input.replyToId ? { replyToId: input.replyToId } : {}),
      value: {
        action: {
          type: "Action.Execute",
          verb: input.actionId,
          data: { actionId: input.actionId, value: input.value },
        },
        trigger: "manual",
      },
      channelData: { tenant: { id: this.tenantId } },
    };
    return new Request("https://rakazo.test/api/v1/messaging/webhook/teams", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(activity),
    });
  }

  /** A Bot Connector token for this app, bound to the emulated service URL. */
  token(overrides: Record<string, unknown> = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const claims = {
      iss: "https://api.botframework.com",
      aud: this.appId,
      serviceurl: this.serviceUrl,
      nbf: now - 60,
      exp: now + 3600,
      ...overrides,
    };
    const signingInput = `${encode({ alg: "RS256", typ: "JWT", kid: "emulated-kid" })}.${encode(claims)}`;
    const signature = sign("sha256", Buffer.from(signingInput), this.key.privateKey);
    return `${signingInput}.${signature.toString("base64url")}`;
  }

  buildActivity(input: TeamsEmulatorInbound) {
    const conversationType = input.conversationType ?? "personal";
    const conversationId =
      input.conversationId ??
      (conversationType === "personal"
        ? "a:emulated-personal"
        : conversationType === "channel"
          ? "19:emulated-channel@thread.tacv2;messageid=1700000000001"
          : "19:emulated-group@thread.v2");
    const from = input.from ?? "29:emulated-user";
    return {
      type: "message",
      id: input.handle ?? `${1700000000000 + randomInt(1_000_000_000)}`,
      timestamp: new Date().toISOString(),
      serviceUrl: this.serviceUrl,
      channelId: "msteams",
      from: { id: from, name: input.fromName ?? "Test User" },
      conversation: {
        id: conversationId,
        conversationType,
        isGroup: conversationType !== "personal",
        tenantId: this.tenantId,
      },
      recipient: { id: this.botAccountId, name: "Rakazo" },
      text: input.mentionBot ? `<at>Rakazo</at> ${input.text}` : input.text,
      textFormat: "plain",
      entities: input.mentionBot
        ? [
            {
              type: "mention",
              mentioned: { id: this.botAccountId, name: "Rakazo" },
              text: "<at>Rakazo</at>",
            },
          ]
        : [],
      channelData: {
        tenant: { id: this.tenantId },
        ...(conversationType === "channel"
          ? {
              team: { id: "19:emulated-team@thread.tacv2", name: "Launch" },
              channel: { id: conversationId.split(";")[0], name: "general" },
            }
          : {}),
      },
    };
  }

  /** A signed inbound webhook for the generic messaging route. */
  buildInboundRequest(input: TeamsEmulatorInbound, token = this.token()): Request {
    return new Request("https://rakazo.test/api/v1/messaging/webhook/teams", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(this.buildActivity(input)),
    });
  }

  resetWitnesses(): void {
    this.sent.length = 0;
    this.updated.length = 0;
  }
}
