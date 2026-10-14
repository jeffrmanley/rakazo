import type { MessagingCommand, MessagingInboundEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";
import { SlackEmulator } from "./slack-emulator.js";

/**
 * Slack slash commands ride the same signed webhook as events
 * (/api/v1/messaging/webhook/slack): the pinned adapter verifies the
 * signature and timestamp, then form-encoded `command=` payloads go to
 * onCommand while JSON event payloads keep reaching onInbound.
 */
describe("Slack slash commands on the messaging surface", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setup() {
    const slack = new SlackEmulator();
    const surface = new ChatSdkMessagingSurface([slack.createPlatform()]);
    const commands: MessagingCommand[] = [];
    const inbound: MessagingInboundEvent[] = [];
    surface.onInbound(async (event) => {
      inbound.push(event);
    });
    surface.onCommand(["/stop", "/resume"], async (command) => {
      commands.push(command);
    });
    return { slack, surface, commands, inbound };
  }

  it("hands a signed /stop to the command handler with its arguments", async () => {
    const { slack, surface, commands, inbound } = setup();
    const res = await surface.handleWebhook(
      "slack",
      slack.buildCommandRequest({ command: "/stop", text: "Alice", userId: "U1", channelId: "C1" }),
    )!;
    expect(res.status).toBe(200);
    await surface.drainCommands();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      provider: "slack",
      command: "/stop",
      text: "Alice",
      from: "U1",
      threadId: "slack:C1",
    });
    expect(inbound).toHaveLength(0);
  });

  it("rejects unsigned, mis-signed and stale (replayed) commands with 401", async () => {
    const { slack, surface, commands } = setup();
    const unsigned = slack.buildCommandRequest({ command: "/stop", userId: "U1" }, { sign: false });
    expect((await surface.handleWebhook("slack", unsigned)!).status).toBe(401);
    const forged = slack.buildCommandRequest(
      { command: "/stop", userId: "U1" },
      { signingSecret: "not-the-secret" },
    );
    expect((await surface.handleWebhook("slack", forged)!).status).toBe(401);
    const stale = slack.buildCommandRequest(
      { command: "/stop", userId: "U1" },
      { timestamp: Math.floor(Date.now() / 1000) - 10 * 60 },
    );
    expect((await surface.handleWebhook("slack", stale)!).status).toBe(401);
    await surface.drainCommands();
    expect(commands).toHaveLength(0);
  });

  it("runs a command once even if the same signed request is delivered twice", async () => {
    const { slack, surface, commands } = setup();
    const body = { command: "/stop", userId: "U1", triggerId: "trigger-1" };
    const timestamp = Math.floor(Date.now() / 1000);
    await surface.handleWebhook("slack", slack.buildCommandRequest(body, { timestamp }));
    await surface.handleWebhook("slack", slack.buildCommandRequest(body, { timestamp }));
    await surface.drainCommands();
    expect(commands).toHaveLength(1);
  });

  it("ignores commands nobody registered", async () => {
    const { slack, surface, commands } = setup();
    const res = await surface.handleWebhook(
      "slack",
      slack.buildCommandRequest({ command: "/weather", userId: "U1" }),
    )!;
    expect(res.status).toBe(200);
    await surface.drainCommands();
    expect(commands).toHaveLength(0);
  });

  it("keeps the events path unchanged: a signed message event reaches onInbound only", async () => {
    const { slack, surface, commands, inbound } = setup();
    const res = await surface.handleWebhook(
      "slack",
      slack.buildEventRequest({ text: "/stop", userId: "U1", channelId: "D1", channelType: "im" }),
    )!;
    expect(res.status).toBe(200);
    expect(inbound).toEqual([
      expect.objectContaining({ type: "message", provider: "slack", content: "/stop", from: "U1" }),
    ]);
    await surface.drainCommands();
    expect(commands).toHaveLength(0);
  });

  it("answers ephemerally through Slack's response_url, and only to Slack", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response("ok");
      }),
    );
    const slack = new SlackEmulator({ recordResponses: false });
    const surface = new ChatSdkMessagingSurface([slack.createPlatform()]);
    const commands: MessagingCommand[] = [];
    surface.onCommand(["/stop"], async (command) => {
      commands.push(command);
    });
    await surface.handleWebhook(
      "slack",
      slack.buildCommandRequest({
        command: "/stop",
        userId: "U1",
        responseUrl: "https://hooks.slack.com/commands/T1/1/abc",
      }),
    );
    await surface.handleWebhook(
      "slack",
      slack.buildCommandRequest({
        command: "/stop",
        userId: "U1",
        triggerId: "trigger-evil",
        responseUrl: "https://attacker.example/collect",
      }),
    );
    await surface.drainCommands();
    await commands[0]!.respond("Stopped Alice.");
    await expect(commands[1]!.respond("Stopped Alice.")).rejects.toThrow(/response_url/);
    expect(posts).toEqual([
      {
        url: "https://hooks.slack.com/commands/T1/1/abc",
        body: { response_type: "ephemeral", text: "Stopped Alice." },
      },
    ]);
  });
});
