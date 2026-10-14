import { createSlackAdapter } from "@chat-adapter/slack";
import { createTeamsAdapter } from "@chat-adapter/teams";
import { createMockAdapter } from "@chat-adapter/tests";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { Adapter } from "chat";
import { describe, expect, it, vi } from "vitest";
import { ChatSdkMessagingSurface } from "./chat-sdk-surface.js";

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "ws-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

/** Every construct agents produce that Slack showed raw before the fix. */
const MARKDOWN = [
  "Here is the **summary** with _emphasis_:",
  "",
  "- first item",
  "- second item with a [link](https://example.test/docs)",
  "",
  "```ts",
  "const x = 1;",
  "```",
].join("\n");

describe("outbound markdown formatting", () => {
  it("posts the reply as a markdown message so each adapter renders it natively", async () => {
    const postMessage = vi.fn(async () => ({ id: "msg-1", threadId: "mock:C1", raw: {} }));
    const adapter: Adapter = createMockAdapter("mock", {
      postMessage,
      postChannelMessage: undefined,
    });
    const surface = new ChatSdkMessagingSurface([
      { provider: "mock", capabilities: { direct: true, groups: true, typing: false }, adapter },
    ]);
    await surface.sendToThread({ threadId: "mock:C1", body: MARKDOWN }, context);
    expect(postMessage).toHaveBeenCalledWith("mock:C1", { markdown: MARKDOWN });
  });

  it("sends Slack the markdown_text field instead of raw markdown in text", async () => {
    const adapter = createSlackAdapter({
      botToken: "xoxb-test-token",
      signingSecret: "test-signing-secret",
    });
    const postMessage = vi.fn(async (_payload: Record<string, unknown>) => ({
      ok: true,
      ts: "1700000000.000100",
    }));
    (
      adapter as unknown as { _client: { chat: { postMessage: unknown } } }
    )._client.chat.postMessage = postMessage;

    const sent = await adapter.postMessage("slack:C123:1700000000.000001", { markdown: MARKDOWN });

    expect(sent.id).toBe("1700000000.000100");
    const payload = postMessage.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.channel).toBe("C123");
    expect(payload.thread_ts).toBe("1700000000.000001");
    expect(payload).not.toHaveProperty("text");
    const markdownText = String(payload.markdown_text);
    expect(markdownText).toContain("**summary**");
    expect(markdownText).toContain("_emphasis_");
    expect(markdownText).toContain("- first item");
    expect(markdownText).toContain("[link](https://example.test/docs)");
    expect(markdownText).toContain("```ts\nconst x = 1;\n```");
  });

  it("renders Slack mrkdwn for surfaces that reject markdown_text", () => {
    const adapter = createSlackAdapter({
      botToken: "xoxb-test-token",
      signingSecret: "test-signing-secret",
    });
    const converter = (
      adapter as unknown as {
        formatConverter: { toResponseUrlText: (message: { markdown: string }) => string };
      }
    ).formatConverter;
    const mrkdwn = converter.toResponseUrlText({ markdown: MARKDOWN });
    expect(mrkdwn).toContain("*summary*");
    expect(mrkdwn).toContain("_emphasis_");
    expect(mrkdwn).toContain("• first item");
    expect(mrkdwn).toContain("<https://example.test/docs|link>");
    expect(mrkdwn).toContain("const x = 1;\n```");
    expect(mrkdwn).not.toContain("**");
  });

  it("keeps Teams on markdown-formatted activities", async () => {
    const adapter = createTeamsAdapter({
      appType: "SingleTenant",
      appId: "00000000-0000-4000-8000-0000000000a1",
      appPassword: "test-teams-app-password",
      appTenantId: "00000000-0000-4000-8000-0000000000b2",
    });
    const send = vi.fn(async (_conversationId: string, _activity: unknown) => ({
      id: "teams-msg-1",
    }));
    (adapter as unknown as { app: { send: unknown } }).app.send = send;
    const threadId = adapter.encodeThreadId({
      conversationId: "a:personal-test",
      conversationType: "personal",
      serviceUrl: "https://smba.trafficmanager.net/teams/",
    });

    const sent = await adapter.postMessage(threadId, { markdown: MARKDOWN });

    expect(sent.id).toBe("teams-msg-1");
    const activity = send.mock.calls[0]![1] as { text: string; textFormat: string };
    expect(activity.textFormat).toBe("markdown");
    expect(activity.text).toContain("**summary**");
    expect(activity.text).toContain("_emphasis_");
    expect(activity.text).toContain("[link](https://example.test/docs)");
    expect(activity.text).toContain("const x = 1;");
    expect(activity.text).toMatch(/^- first item$/m);
  });
});
