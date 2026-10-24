import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { sessionCookieHeader } from "./index.js";

type AppHandles = Awaited<ReturnType<typeof createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe.sequential : describe.skip;
const origin = "http://127.0.0.1:5173";

/** Reads a streaming response until it ends or the deadline passes. */
async function readUntilClosed(response: Response, deadlineMs: number) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
    ]);
    if (chunk === "timeout") continue;
    if (chunk.done) return { closed: true, text };
    text += decoder.decode(chunk.value, { stream: true });
  }
  await reader.cancel();
  return { closed: false, text };
}

describeWithDatabase("live streams re-check the session", () => {
  let handles: AppHandles;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-session-recheck-"));
  const post = (route: string, body: unknown, cookie = "") =>
    handles.app.request(route, {
      method: "POST",
      headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      webOrigin: origin,
      authUrl: origin,
      signupsEnabled: "true",
      signupAllowlist: "@allowed.test",
    });
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("ends an open thread stream after the session is revoked", { timeout: 90_000 }, async () => {
    const signedUp = await post("/api/auth/sign-up/email", {
      email: "owner@allowed.test",
      password: "owner-password-123",
      name: "Owner",
    });
    expect(signedUp.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(signedUp);
    const created = await post(
      "/rpc/bots/create",
      {
        json: {
          name: "Watcher",
          title: "",
          description: "",
          instructions: "",
          notifyOnFinish: false,
        },
      },
      cookie,
    );
    expect(created.status).toBe(200);
    const bot = ((await created.json()) as { json: { id: string } }).json;

    const stream = await post(
      "/rpc/threads/subscribe",
      { json: { botId: bot.id, cursor: -1 } },
      cookie,
    );
    expect(stream.status).toBe(200);

    // Revoke every session of the user; the stream must notice at its next re-check (heartbeat).
    await handles.prisma.session.deleteMany({});
    // The stream ends at the re-check after the next heartbeat (oRPC closes it rather than
    // sending an error event). With the per-request memo it stayed open past the deadline.
    const result = await readUntilClosed(stream, 60_000);
    expect(result.closed).toBe(true);
  });
});
