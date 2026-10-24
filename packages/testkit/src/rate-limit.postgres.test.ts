import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { createTestAccount } from "../../auth/src/test-accounts.js";
import { sessionCookieHeader } from "./index.js";

type AppHandles = Awaited<ReturnType<typeof createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe.sequential : describe.skip;
const origin = "http://127.0.0.1:5173";
const policyEnv = { signupsEnabled: "true", signupAllowlist: "@allowed.test" };

describeWithDatabase("API-wide rate limits", () => {
  let handles: AppHandles;
  let owner = "";
  let other = "";
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-rate-limit-"));
  const post = (route: string, body: unknown, cookie = "", headers: Record<string, string> = {}) =>
    handles.app.request(route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const me = (cookie = "", headers: Record<string, string> = {}) =>
    post("/rpc/me", { json: {} }, cookie, headers);

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
      ...policyEnv,
      rateLimit: {
        enabled: true,
        userPerMinute: 5,
        anonPerMinute: 3,
        anonGlobalPerMinute: 100,
        expensivePerMinute: 2,
        webhookPerMinute: 8,
        webhookGlobalPerMinute: 100,
      },
    });
    const signedUp = await post("/api/auth/sign-up/email", {
      email: "owner@allowed.test",
      password: "owner-password-123",
      name: "Owner",
    });
    expect(signedUp.status).toBeLessThan(400);
    owner = sessionCookieHeader(signedUp);
    const account = await createTestAccount(handles.prisma, {
      password: "other-password-1234",
      policyEnv,
      passwordAuth: true,
    });
    if (!account.ok) throw new Error(account.reason);
    other = sessionCookieHeader(
      await post("/api/auth/sign-in/email", {
        email: account.value.email,
        password: "other-password-1234",
      }),
    );
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("cuts a user off past the limit with Retry-After and an error id; others are unaffected", async () => {
    for (let i = 0; i < 5; i += 1) expect((await me(owner)).status).toBe(200);
    const refused = await me(owner);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = (await refused.json()) as { error: string; error_id: string };
    expect(body.error).toBe("Too many requests");
    expect(body.error_id).toMatch(/^[0-9a-f-]{36}$/);
    // The REST surface shares the user's bucket.
    expect(
      (await handles.app.request("/api/v1/ext/modules", { headers: { cookie: owner } })).status,
    ).toBe(429);
    expect((await me(other)).status).toBe(200);
  });

  it("limits anonymous requests per client address", async () => {
    const from = { "x-forwarded-for": "198.51.100.7" };
    for (let i = 0; i < 3; i += 1) expect((await me("", from)).status).not.toBe(429);
    expect((await me("", from)).status).toBe(429);
    expect((await me("", { "x-forwarded-for": "198.51.100.8" })).status).not.toBe(429);
  });

  it("limits webhooks per sending address, apart from the app's own buckets", async () => {
    const hook = (address: string) =>
      post("/api/v1/messaging/webhook/slack", { type: "event_callback" }, "", {
        "x-forwarded-for": address,
      });
    for (let i = 0; i < 8; i += 1) {
      const response = await hook("203.0.113.9");
      // Refused by the Slack adapter for having no signature, never by the limiter.
      expect(response.status).not.toBe(429);
    }
    expect((await hook("203.0.113.9")).status).toBe(429);
    expect((await hook("203.0.113.10")).status).not.toBe(429);
    expect((await me(other)).status).toBe(200);
  });

  it("limits calls that start work more tightly than other calls", async () => {
    const send = (cookie: string) =>
      post("/rpc/threads/send", { json: { botId: "missing", text: "hi" } }, cookie);
    expect((await send(other)).status).not.toBe(429);
    expect((await send(other)).status).not.toBe(429);
    expect((await send(other)).status).toBe(429);
  });

  it("leaves sign-in to better-auth's own limiter", async () => {
    const response = await post("/api/auth/sign-in/email", {
      email: "owner@allowed.test",
      password: "owner-password-123",
    });
    expect(response.status).toBe(200);
  });
});
