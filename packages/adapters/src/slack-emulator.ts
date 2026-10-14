import { createHmac, randomUUID } from "node:crypto";
import type { MessagingPlatform } from "./chat-sdk-surface.js";
import { messagingPlatformsFromEnv } from "./messaging-platforms.js";

export interface SlackEmulatorCommand {
  command: string;
  text?: string;
  userId: string;
  channelId?: string;
  teamId?: string;
  triggerId?: string;
  responseUrl?: string;
}

export interface SlackEmulatorEvent {
  text: string;
  userId: string;
  channelId: string;
  channelType?: "im" | "channel" | "group" | "mpim";
  ts?: string;
}

export interface SlackEmulatorSignOptions {
  /** False sends no signature headers at all. */
  sign?: boolean;
  /** Sign with another secret (a forged request). */
  signingSecret?: string;
  /** Unix seconds; an old value is a replayed request. */
  timestamp?: number;
}

/**
 * Deterministic Slack stand-in for CI: the real pinned adapter verifies
 * locally signed requests (HMAC over `v0:<timestamp>:<body>` with the test
 * signing secret), the Web API client is replaced by an offline fake, and
 * slash command replies to response_url are recorded instead of posted.
 */
export class SlackEmulator {
  readonly signingSecret = "emulated-slack-signing-secret";
  readonly botToken = "xoxb-emulated";
  readonly teamId = "T-EMULATED";
  readonly botUserId = "U-EMULATED-BOT";
  /** Ephemeral command replies (response_url posts). */
  readonly responses: Array<{ responseUrl: string; text: string; responseType: string }> = [];
  /** Messages posted through the Web API (chat.postMessage). */
  readonly posted: Array<{ channel: string; text: string }> = [];
  private readonly recordResponses: boolean;
  private counter = 0;

  constructor(options: { recordResponses?: boolean } = {}) {
    this.recordResponses = options.recordResponses ?? true;
  }

  /** The production Slack platform with the Web API faked and replies recorded. */
  createPlatform(): MessagingPlatform {
    const platform = messagingPlatformsFromEnv({
      slackBotToken: this.botToken,
      slackSigningSecret: this.signingSecret,
    })[0];
    if (platform?.provider !== "slack") throw new Error("Slack platform not built");
    (platform.adapter as unknown as { _client: unknown })._client = this.fakeWebClient();
    if (this.recordResponses) {
      platform.respondToCommand = async (raw, body) => {
        const responseUrl = String((raw as { response_url?: unknown }).response_url ?? "");
        this.responses.push({ responseUrl, text: body, responseType: "ephemeral" });
      };
    }
    return platform;
  }

  /** A form-encoded slash command, as Slack posts it to the Request URL. */
  buildCommandRequest(
    input: SlackEmulatorCommand,
    options: SlackEmulatorSignOptions = {},
  ): Request {
    this.counter += 1;
    const channelId = input.channelId ?? "C-EMULATED";
    const body = new URLSearchParams({
      token: "deprecated-verification-token",
      team_id: input.teamId ?? this.teamId,
      team_domain: "emulated",
      channel_id: channelId,
      channel_name: channelId.startsWith("D") ? "directmessage" : "general",
      user_id: input.userId,
      user_name: input.userId.toLowerCase(),
      command: input.command,
      text: input.text ?? "",
      api_app_id: "A-EMULATED",
      response_url:
        input.responseUrl ?? `https://hooks.slack.com/commands/${this.teamId}/${this.counter}/x`,
      trigger_id: input.triggerId ?? `trigger-${this.counter}-${randomUUID()}`,
    }).toString();
    return this.request(body, "application/x-www-form-urlencoded", options);
  }

  /** A signed Events API message event. */
  buildEventRequest(input: SlackEmulatorEvent, options: SlackEmulatorSignOptions = {}): Request {
    this.counter += 1;
    const ts =
      input.ts ?? `${Math.floor(Date.now() / 1000)}.${String(this.counter).padStart(6, "0")}`;
    const body = JSON.stringify({
      token: "deprecated-verification-token",
      team_id: this.teamId,
      api_app_id: "A-EMULATED",
      type: "event_callback",
      event_id: `Ev-${this.counter}-${randomUUID()}`,
      event_time: Math.floor(Date.now() / 1000),
      authorizations: [{ team_id: this.teamId, user_id: this.botUserId, is_bot: true }],
      event: {
        type: "message",
        channel: input.channelId,
        channel_type: input.channelType ?? "channel",
        user: input.userId,
        text: input.text,
        ts,
        team: this.teamId,
      },
    });
    return this.request(body, "application/json", options);
  }

  resetWitnesses(): void {
    this.responses.length = 0;
    this.posted.length = 0;
  }

  private request(body: string, contentType: string, options: SlackEmulatorSignOptions): Request {
    const headers = new Headers({ "content-type": contentType });
    if (options.sign !== false) {
      const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", options.signingSecret ?? this.signingSecret)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex");
      headers.set("x-slack-request-timestamp", timestamp);
      headers.set("x-slack-signature", `v0=${signature}`);
    }
    return new Request("https://rakazo.test/api/v1/messaging/webhook/slack", {
      method: "POST",
      headers,
      body,
    });
  }

  /** Offline Web API: answers the calls the adapter makes on the inbound paths. */
  private fakeWebClient() {
    const methods: Record<string, (args: Record<string, unknown>) => unknown> = {
      "auth.test": () => ({
        ok: true,
        user_id: this.botUserId,
        bot_id: "B-EMULATED",
        user: "crew",
      }),
      "users.info": (args) => ({
        ok: true,
        user: {
          id: args.user,
          name: String(args.user).toLowerCase(),
          real_name: "Slack User",
          is_bot: false,
          profile: { display_name: "slack-user", real_name: "Slack User" },
        },
      }),
      "conversations.info": (args) => ({
        ok: true,
        channel: { id: args.channel, name: "general", is_im: String(args.channel).startsWith("D") },
      }),
      "chat.postMessage": (args) => {
        this.posted.push({ channel: String(args.channel), text: String(args.text ?? "") });
        return { ok: true, channel: args.channel, ts: `${Date.now() / 1000}` };
      },
    };
    return new Proxy(
      {},
      {
        get: (_target, namespace) =>
          typeof namespace !== "string" || namespace === "then"
            ? undefined
            : new Proxy(
                {},
                {
                  get: (_inner, method) =>
                    typeof method !== "string" || method === "then"
                      ? undefined
                      : async (args: Record<string, unknown> = {}) =>
                          methods[`${namespace}.${method}`]?.(args) ?? { ok: true },
                },
              ),
      },
    );
  }
}
