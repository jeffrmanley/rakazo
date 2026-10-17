import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import {
  createTestAccount,
  deleteTestAccount,
  listTestAccounts,
} from "../../auth/src/test-accounts.js";
import { sessionCookieHeader } from "./index.js";

type AppHandles = Awaited<ReturnType<typeof createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe.sequential : describe.skip;
const origin = "http://127.0.0.1:5173";
// Allowlist-only sign-ups and no email delivery: what a real deployment looks like.
const policyEnv = { signupsEnabled: "true", signupAllowlist: "@allowed.test" };

describeWithDatabase("test accounts on an allowlist-only deployment", () => {
  let handles: AppHandles;
  let ownerId: string;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-test-accounts-"));
  const request = (input: string, init?: RequestInit) => handles.app.request(input, init);
  const post = (route: string, body: unknown, cookie = "") =>
    request(route, {
      method: "POST",
      headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const signIn = (email: string, password: string) =>
    post("/api/auth/sign-in/email", { email, password });

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
    });
    const owner = await post("/api/auth/sign-up/email", {
      email: "owner@allowed.test",
      password: "owner-password-123",
      name: "Owner",
    });
    expect(owner.status).toBeLessThan(400);
    ownerId = (
      await handles.prisma.user.findUniqueOrThrow({
        where: { email: "owner@allowed.test" },
      })
    ).id;
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("a second person cannot sign up without email delivery", async () => {
    const response = await post("/api/auth/sign-up/email", {
      email: "second@allowed.test",
      password: "second-password-123",
      name: "Second",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Registration requires email delivery");
  });

  it("creates a verified non-owner account in its own space that can sign in", async () => {
    const password = "test-account-password-1";
    const created = await createTestAccount(handles.prisma, { password, policyEnv });
    if (!created.ok) throw new Error(created.reason);
    const { email, userId, spaceId } = created.value;
    expect(email).toMatch(/^live-test-[0-9a-f]{12}@live-test\.invalid$/);

    const user = await handles.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.emailVerified).toBe(true);
    expect(user.email).toBe(email);
    const membership = await handles.prisma.spaceMember.findFirstOrThrow({ where: { userId } });
    expect(membership).toMatchObject({ spaceId, role: "owner" });
    const ownerSpace = await handles.prisma.spaceMember.findFirstOrThrow({
      where: { userId: ownerId },
    });
    expect(ownerSpace.spaceId).not.toBe(spaceId);
    const settings = await handles.prisma.deploymentSettings.findUniqueOrThrow({
      where: { id: "default" },
    });
    expect(settings).toMatchObject({
      ownerUserId: ownerId,
      signupsEnabled: true,
      signupAllowlist: "@allowed.test",
    });

    const signedIn = await signIn(email, password);
    expect(signedIn.status).toBe(200);
    const cookie = sessionCookieHeader(signedIn);
    expect(await signIn(email, "wrong-password-123456")).toHaveProperty("status", 401);

    const me = await post("/rpc/me", { json: {} }, cookie);
    expect(me.status).toBe(200);
    const brand = await post("/rpc/brand/update", { json: { name: "hijacked" } }, cookie);
    expect(brand.status).toBe(403);
    const bot = await post(
      "/rpc/bots/create",
      {
        json: {
          name: "Checker",
          title: "",
          description: "",
          instructions: "",
          notifyOnFinish: false,
        },
      },
      cookie,
    );
    expect(bot.status).toBe(200);
    expect(await handles.prisma.bot.count({ where: { userId } })).toBe(1);
  });

  it("lists only test accounts, newest first", async () => {
    const second = await createTestAccount(handles.prisma, {
      password: "another-password-12",
      policyEnv,
    });
    if (!second.ok) throw new Error(second.reason);
    const listed = await listTestAccounts(handles.prisma);
    expect(listed.length).toBe(2);
    expect(listed[0]!.email).toBe(second.value.email);
    expect(listed.map((account) => account.email)).not.toContain("owner@allowed.test");
  });

  it("deletes through the API's own account deletion, then reports the account absent", async () => {
    for (const { email } of await listTestAccounts(handles.prisma)) {
      const user = await handles.prisma.user.findUniqueOrThrow({ where: { email } });
      const spaceIds = (
        await handles.prisma.spaceMember.findMany({ where: { userId: user.id } })
      ).map((member) => member.spaceId);
      const deleted = await deleteTestAccount(handles.prisma, {
        email,
        webOrigin: origin,
        request,
      });
      expect(deleted).toEqual({ ok: true, value: "deleted" });
      expect(await handles.prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
      expect(await handles.prisma.session.count({ where: { userId: user.id } })).toBe(0);
      expect(await handles.prisma.bot.count({ where: { userId: user.id } })).toBe(0);
      expect(await handles.prisma.space.count({ where: { id: { in: spaceIds } } })).toBe(0);
      expect(
        await deleteTestAccount(handles.prisma, { email, webOrigin: origin, request }),
      ).toEqual({ ok: true, value: "absent" });
    }
    expect(await listTestAccounts(handles.prisma)).toEqual([]);
  });

  it("refuses to delete a real account, which stays intact", async () => {
    const refused = await deleteTestAccount(handles.prisma, {
      email: "owner@allowed.test",
      webOrigin: origin,
      request,
    });
    expect(refused.ok).toBe(false);
    expect(await handles.prisma.user.findUnique({ where: { id: ownerId } })).not.toBeNull();
    expect((await signIn("owner@allowed.test", "owner-password-123")).status).toBe(200);
  });
});
