import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadExtEnv } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { createTestAccount } from "../../auth/src/test-accounts.js";
import { resetTwoFactor } from "../../auth/src/two-factor.js";
import { awayFromTotpBoundary, base32Decode, totpCode, wrongTotpCode } from "./totp.js";

type AppHandles = Awaited<ReturnType<typeof createApp>>;

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe.sequential : describe.skip;
const origin = "http://127.0.0.1:5173";
const policyEnv = { signupsEnabled: "true", signupAllowlist: "" };
const BRAND = "Crew Two-Factor Test";
const SECRET = process.env.BETTER_AUTH_SECRET ?? "test-secret-test-secret-32chars!";
const OWNER = { email: "owner@two-factor.test", password: "owner-password-123" };
const MEMBER = { email: "member@two-factor.test", password: "member-password-123" };
const LATE = { email: "late@two-factor.test", password: "late-password-1234" };

/** Cookies a browser would hold for one tab or device. */
class Jar {
  readonly values = new Map<string, string>();
  constructor(from?: Jar) {
    if (from) for (const [name, value] of from.values) this.values.set(name, value);
  }
  take(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const at = pair!.indexOf("=");
      const name = pair!.slice(0, at).trim();
      const value = pair!.slice(at + 1).trim();
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute));
      if (expired || value === "") this.values.delete(name);
      else this.values.set(name, value);
    }
  }
  has(fragment: string) {
    return [...this.values.keys()].some((name) => name.includes(fragment));
  }
  header() {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

describeWithDatabase("authenticator-app two-factor sign-in", () => {
  let handles: AppHandles;
  let ownerId: string;
  let memberId: string;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-two-factor-"));
  const owner = new Jar();
  const member = new Jar();
  let ownerUri = "";
  let ownerBackupCodes: string[] = [];

  const send = async (route: string, init: RequestInit, jar?: Jar) => {
    const response = await handles.app.request(route, {
      ...init,
      headers: {
        origin,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(jar?.values.size ? { cookie: jar.header() } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    jar?.take(response);
    return response;
  };
  const post = (route: string, body: unknown, jar?: Jar) =>
    send(route, { method: "POST", body: JSON.stringify(body) }, jar);
  const get = (route: string, jar?: Jar) => send(route, { method: "GET" }, jar);
  const json = async <T = Record<string, unknown>>(response: Response) =>
    (await response.json()) as T;
  const signIn = (who: { email: string; password: string }, jar: Jar) =>
    post("/api/auth/sign-in/email", { email: who.email, password: who.password }, jar);
  const policy = async (jar: Jar) => json(await get("/api/auth/two-factor-policy", jar));
  const me = (jar: Jar) => post("/rpc/me", { json: {} }, jar);
  const auditKinds = async (userId: string) =>
    (
      await handles.prisma.extAuditEvent.findMany({
        where: { actorId: userId },
        orderBy: { at: "asc" },
      })
    ).map((event) => event.kind);
  const failures = (userId: string) =>
    handles.prisma.extAuditEvent.findMany({
      where: { kind: "auth.2fa_failed", actorId: userId },
      orderBy: { at: "asc" },
    });

  /** Starts a password sign-in on a fresh device; the response asks for the second factor. */
  const pendingSignIn = async (who: { email: string; password: string }, from?: Jar) => {
    const jar = new Jar(from);
    const response = await signIn(who, jar);
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ twoFactorRedirect: true });
    expect(jar.has("session_token")).toBe(false);
    return jar;
  };

  const enrol = async (jar: Jar, password: string) => {
    const enabled = await post("/api/auth/two-factor/enable", { password }, jar);
    expect(enabled.status).toBe(200);
    const body = await json<{ totpURI: string; backupCodes: string[] }>(enabled);
    await awayFromTotpBoundary();
    const confirmed = await post(
      "/api/auth/two-factor/verify-totp",
      { code: totpCode(body.totpURI) },
      jar,
    );
    expect(confirmed.status).toBe(200);
    return body;
  };

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
      ext: { ...loadExtEnv({}), auditLog: true },
      ...policyEnv,
    });
    for (const [who, jar] of [
      [OWNER, owner],
      [MEMBER, member],
    ] as const) {
      const response = await post(
        "/api/auth/sign-up/email",
        { email: who.email, password: who.password, name: who.email.split("@")[0] },
        jar,
      );
      expect(response.status).toBeLessThan(400);
    }
    ownerId = (await handles.prisma.user.findUniqueOrThrow({ where: { email: OWNER.email } })).id;
    memberId = (await handles.prisma.user.findUniqueOrThrow({ where: { email: MEMBER.email } })).id;
    const settings = await handles.prisma.deploymentSettings.findUniqueOrThrow({
      where: { id: "default" },
    });
    expect(settings.ownerUserId).toBe(ownerId);
    expect(settings.require2faForAll).toBe(false);
    expect((await post("/rpc/brand/update", { json: { name: BRAND } }, owner)).status).toBe(200);
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("shows the owner the enrolment banner state without locking them out", async () => {
    expect(await policy(owner)).toEqual({
      enabled: false,
      required: true,
      enforcement: "banner",
      available: true,
    });
    expect((await me(owner)).status).toBe(200);
    expect(await policy(member)).toEqual({
      enabled: false,
      required: false,
      enforcement: "none",
      available: true,
    });
    expect((await get("/api/auth/two-factor-policy")).status).toBe(401);
  });

  it("enrols: the secret is encrypted, the backup codes hashed, and a code confirms it", async () => {
    const wrongPassword = await post(
      "/api/auth/two-factor/enable",
      { password: "nope-nope-nope" },
      owner,
    );
    expect(wrongPassword.status).toBe(400);

    const response = await post(
      "/api/auth/two-factor/enable",
      { password: OWNER.password, issuer: "Spoofed issuer" },
      owner,
    );
    expect(response.status).toBe(200);
    const { totpURI, backupCodes } = await json<{ totpURI: string; backupCodes: string[] }>(
      response,
    );
    const uri = new URL(totpURI);
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.searchParams.get("issuer")).toBe(BRAND);
    expect(decodeURIComponent(uri.pathname)).toContain(OWNER.email);
    expect(backupCodes).toHaveLength(10);
    expect(new Set(backupCodes).size).toBe(10);

    const row = await handles.prisma.twoFactor.findUniqueOrThrow({ where: { userId: ownerId } });
    const base32 = uri.searchParams.get("secret")!;
    const raw = base32Decode(base32).toString("utf8");
    expect(row.verified).toBe(false);
    expect(row.secret).not.toContain(base32);
    expect(row.secret).not.toContain(raw);
    expect(row.secret).toMatch(/^(\$ba\$\d+\$)?[0-9a-f]+$/);
    for (const code of backupCodes) expect(row.backupCodes).not.toContain(code);
    expect(JSON.parse(row.backupCodes)).toHaveLength(10);
    // Not on until a code from the app confirms it.
    expect(
      (await handles.prisma.user.findUniqueOrThrow({ where: { id: ownerId } })).twoFactorEnabled,
    ).toBe(false);
    expect(await policy(owner)).toMatchObject({ enabled: false, enforcement: "banner" });

    const wrong = await post(
      "/api/auth/two-factor/verify-totp",
      { code: wrongTotpCode(totpURI) },
      owner,
    );
    expect(wrong.status).toBe(401);
    expect(await json(wrong)).toMatchObject({ code: "INVALID_CODE" });

    await awayFromTotpBoundary();
    const confirmed = await post(
      "/api/auth/two-factor/verify-totp",
      { code: totpCode(totpURI) },
      owner,
    );
    expect(confirmed.status).toBe(200);
    expect(
      (await handles.prisma.user.findUniqueOrThrow({ where: { id: ownerId } })).twoFactorEnabled,
    ).toBe(true);
    expect(
      (await handles.prisma.twoFactor.findUniqueOrThrow({ where: { userId: ownerId } })).verified,
    ).toBe(true);
    expect(await policy(owner)).toEqual({
      enabled: true,
      required: true,
      enforcement: "none",
      available: true,
    });
    expect((await me(owner)).status).toBe(200);
    expect(await auditKinds(ownerId)).toEqual(
      expect.arrayContaining(["auth.2fa_failed", "auth.2fa_enabled"]),
    );

    const again = await post("/api/auth/two-factor/enable", { password: OWNER.password }, owner);
    expect(again.status).toBe(400);
    expect(await json(again)).toMatchObject({ code: "TOTP_ALREADY_ENABLED" });
    ownerUri = totpURI;
    ownerBackupCodes = backupCodes;
  });

  it("refuses password-only sign-in: no session until the second factor", async () => {
    const sessions = await handles.prisma.session.count({ where: { userId: ownerId } });
    const jar = await pendingSignIn(OWNER);
    expect(jar.has("two_factor")).toBe(true);
    expect(await handles.prisma.session.count({ where: { userId: ownerId } })).toBe(sessions);
    expect((await me(jar)).status).toBe(401);
    expect((await get("/api/auth/two-factor-policy", jar)).status).toBe(401);
  });

  it("signs in with a current code, accepting one time step either way and no further", async () => {
    for (const steps of [0, -1, 1]) {
      await awayFromTotpBoundary();
      const jar = await pendingSignIn(OWNER);
      const verified = await post(
        "/api/auth/two-factor/verify-totp",
        { code: totpCode(ownerUri, steps) },
        jar,
      );
      expect(verified.status, `step ${steps}`).toBe(200);
      expect(jar.has("session_token")).toBe(true);
      expect(jar.has("two_factor")).toBe(false);
      expect((await me(jar)).status).toBe(200);
    }
    for (const steps of [-2, 2]) {
      await awayFromTotpBoundary();
      const jar = await pendingSignIn(OWNER);
      const refused = await post(
        "/api/auth/two-factor/verify-totp",
        { code: totpCode(ownerUri, steps) },
        jar,
      );
      expect(refused.status, `step ${steps}`).toBe(401);
    }
    // A success clears the account-level failure count the refusals added.
    const jar = await pendingSignIn(OWNER);
    await awayFromTotpBoundary();
    expect(
      (await post("/api/auth/two-factor/verify-totp", { code: totpCode(ownerUri) }, jar)).status,
    ).toBe(200);
  });

  it("refuses a wrong code and audits it with the user and an error id, never the code", async () => {
    const before = (await failures(ownerId)).length;
    const jar = await pendingSignIn(OWNER);
    const code = wrongTotpCode(ownerUri);
    const refused = await post("/api/auth/two-factor/verify-totp", { code }, jar);
    expect(refused.status).toBe(401);
    expect(await json(refused)).toMatchObject({ code: "INVALID_CODE" });
    const events = await failures(ownerId);
    expect(events).toHaveLength(before + 1);
    const event = events.at(-1)!;
    expect(event.detail).toMatchObject({
      userId: ownerId,
      reason: "INVALID_CODE",
      errorId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(JSON.stringify(event)).not.toContain(code);
    const row = await handles.prisma.twoFactor.findUniqueOrThrow({ where: { userId: ownerId } });
    expect(JSON.stringify(event)).not.toContain(row.secret);
  });

  it("allows five attempts per pending sign-in, then wants a new sign-in", async () => {
    const jar = await pendingSignIn(OWNER);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const refused = await post(
        "/api/auth/two-factor/verify-totp",
        { code: wrongTotpCode(ownerUri) },
        jar,
      );
      expect(refused.status, `attempt ${attempt}`).toBe(401);
    }
    await awayFromTotpBoundary();
    const blocked = await post(
      "/api/auth/two-factor/verify-totp",
      { code: totpCode(ownerUri) },
      jar,
    );
    expect(blocked.status).toBe(400);
    expect(await json(blocked)).toMatchObject({ code: "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" });
    expect(jar.has("session_token")).toBe(false);
    const sixth = (await failures(ownerId)).at(-1)!;
    expect(sixth.detail).toMatchObject({
      userId: ownerId,
      reason: "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
    });

    const fresh = await pendingSignIn(OWNER);
    await awayFromTotpBoundary();
    expect(
      (await post("/api/auth/two-factor/verify-totp", { code: totpCode(ownerUri) }, fresh)).status,
    ).toBe(200);
  });

  it("lets a pending sign-in expire after five minutes", async () => {
    const jar = await pendingSignIn(OWNER);
    await handles.prisma.verification.updateMany({
      where: { value: ownerId, identifier: { startsWith: "2fa-" } },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await awayFromTotpBoundary();
    const expired = await post(
      "/api/auth/two-factor/verify-totp",
      { code: totpCode(ownerUri) },
      jar,
    );
    expect(expired.status).toBe(401);
    expect(await json(expired)).toMatchObject({ code: "INVALID_TWO_FACTOR_COOKIE" });
  });

  it("accepts each backup code once", async () => {
    const [code] = ownerBackupCodes;
    const first = await pendingSignIn(OWNER);
    const used = await post("/api/auth/two-factor/verify-backup-code", { code }, first);
    expect(used.status).toBe(200);
    expect((await me(first)).status).toBe(200);
    const row = await handles.prisma.twoFactor.findUniqueOrThrow({ where: { userId: ownerId } });
    expect(JSON.parse(row.backupCodes)).toHaveLength(9);

    const second = await pendingSignIn(OWNER);
    const reused = await post("/api/auth/two-factor/verify-backup-code", { code }, second);
    expect(reused.status).toBe(401);
    expect(await json(reused)).toMatchObject({ code: "INVALID_BACKUP_CODE" });
    // The stored digest is not a code either.
    const digest = (JSON.parse(row.backupCodes) as string[])[0]!;
    const asCode = await post("/api/auth/two-factor/verify-backup-code", { code: digest }, second);
    expect(asCode.status).toBe(401);
    ownerBackupCodes = ownerBackupCodes.slice(1);
  });

  it("trusts a device for thirty days when asked, and only that device", async () => {
    const device = await pendingSignIn(OWNER);
    await awayFromTotpBoundary();
    const verified = await post(
      "/api/auth/two-factor/verify-totp",
      { code: totpCode(ownerUri), trustDevice: true },
      device,
    );
    expect(verified.status).toBe(200);
    expect(device.has("trust_device")).toBe(true);
    const trust = await handles.prisma.verification.findFirstOrThrow({
      where: { value: ownerId, identifier: { startsWith: "trust-device-" } },
    });
    const days = (trust.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    const signedOut = new Jar(device);
    for (const name of [...signedOut.values.keys()])
      if (name.includes("session_token")) signedOut.values.delete(name);
    const again = await signIn(OWNER, signedOut);
    expect(again.status).toBe(200);
    expect(await json(again)).not.toHaveProperty("twoFactorRedirect");
    expect(signedOut.has("session_token")).toBe(true);
    // Another device still needs the code.
    await pendingSignIn(OWNER);
  });

  it("fails the older of two concurrent enrolments cleanly, without replacing a confirmed secret", async () => {
    // Two tabs of one browser share its cookies.
    const tab = member;
    const a = await json<{ totpURI: string }>(
      await post("/api/auth/two-factor/enable", { password: MEMBER.password }, tab),
    );
    const b = await json<{ totpURI: string }>(
      await post("/api/auth/two-factor/enable", { password: MEMBER.password }, tab),
    );
    expect(a.totpURI).not.toBe(b.totpURI);
    expect(await handles.prisma.twoFactor.count({ where: { userId: memberId } })).toBe(1);
    await awayFromTotpBoundary();
    const staleA = await post(
      "/api/auth/two-factor/verify-totp",
      { code: totpCode(a.totpURI) },
      tab,
    );
    expect(staleA.status).toBe(401);
    expect(await json(staleA)).toMatchObject({ code: "INVALID_CODE" });
    const confirmedB = await post(
      "/api/auth/two-factor/verify-totp",
      { code: totpCode(b.totpURI) },
      tab,
    );
    expect(confirmedB.status).toBe(200);
    // Tab A cannot start over once B confirmed, and its code still fails.
    const restart = await post("/api/auth/two-factor/enable", { password: MEMBER.password }, tab);
    expect(restart.status).toBe(400);
    expect(await json(restart)).toMatchObject({ code: "TOTP_ALREADY_ENABLED" });
    const lateA = await post(
      "/api/auth/two-factor/verify-totp",
      { code: totpCode(a.totpURI) },
      tab,
    );
    expect(lateA.status).toBe(401);
    const pending = await pendingSignIn(MEMBER);
    await awayFromTotpBoundary();
    expect(
      (await post("/api/auth/two-factor/verify-totp", { code: totpCode(b.totpURI) }, pending))
        .status,
    ).toBe(200);
  });

  it("disables only with the password and a current code", async () => {
    const noCode = await post("/api/auth/two-factor/disable", { password: OWNER.password }, owner);
    expect(noCode.status).toBe(400);
    expect(await json(noCode)).toMatchObject({ code: "TWO_FACTOR_CODE_REQUIRED" });

    const failed = (await failures(ownerId)).length;
    const wrongCode = await post(
      "/api/auth/two-factor/disable",
      { password: OWNER.password, code: wrongTotpCode(ownerUri) },
      owner,
    );
    expect(wrongCode.status).toBe(401);
    expect((await failures(ownerId)).length).toBe(failed + 1);

    await awayFromTotpBoundary();
    const wrongPassword = await post(
      "/api/auth/two-factor/disable",
      { password: "not-the-password-1", code: totpCode(ownerUri) },
      owner,
    );
    expect(wrongPassword.status).toBe(400);
    expect(
      (await handles.prisma.user.findUniqueOrThrow({ where: { id: ownerId } })).twoFactorEnabled,
    ).toBe(true);

    const signedOut = await post("/api/auth/two-factor/disable", {
      password: OWNER.password,
      code: totpCode(ownerUri),
    });
    expect(signedOut.status).toBe(401);

    await awayFromTotpBoundary();
    const disabled = await post(
      "/api/auth/two-factor/disable",
      { password: OWNER.password, code: totpCode(ownerUri) },
      owner,
    );
    expect(disabled.status).toBe(200);
    expect(
      (await handles.prisma.user.findUniqueOrThrow({ where: { id: ownerId } })).twoFactorEnabled,
    ).toBe(false);
    expect(await handles.prisma.twoFactor.count({ where: { userId: ownerId } })).toBe(0);
    expect((await auditKinds(ownerId)).at(-1)).toBe("auth.2fa_disabled");
    expect(await policy(owner)).toMatchObject({ enabled: false, enforcement: "banner" });
    expect((await me(owner)).status).toBe(200);
  });

  it("disables with a backup code in place of the authenticator", async () => {
    const enrolled = await enrol(owner, OWNER.password);
    const failed = (await failures(ownerId)).length;
    // A wrong password is refused before the code is looked at, so the backup code survives.
    const wrongPassword = await post(
      "/api/auth/two-factor/disable",
      { password: "not-the-password-1", code: enrolled.backupCodes[0] },
      owner,
    );
    expect(wrongPassword.status).toBe(400);
    expect(await json(wrongPassword)).toMatchObject({ code: "INVALID_PASSWORD" });
    expect((await failures(ownerId)).length).toBe(failed);
    const stored = await handles.prisma.twoFactor.findUniqueOrThrow({ where: { userId: ownerId } });
    expect(JSON.parse(stored.backupCodes)).toHaveLength(10);
    const disabled = await post(
      "/api/auth/two-factor/disable",
      { password: OWNER.password, code: enrolled.backupCodes[0] },
      owner,
    );
    expect(disabled.status).toBe(200);
    expect(await handles.prisma.twoFactor.count({ where: { userId: ownerId } })).toBe(0);
  });

  it("lets only the owner require two-factor for everyone, and audits the change", async () => {
    const denied = await post(
      "/rpc/deployment/update",
      { json: { require2faForAll: true } },
      member,
    );
    expect(denied.status).toBe(403);
    expect(
      (await handles.prisma.deploymentSettings.findUniqueOrThrow({ where: { id: "default" } }))
        .require2faForAll,
    ).toBe(false);

    const allowed = await post(
      "/rpc/deployment/update",
      { json: { require2faForAll: true } },
      owner,
    );
    expect(allowed.status).toBe(200);
    expect(
      (await json<{ json: { require2faForAll: boolean } }>(allowed)).json.require2faForAll,
    ).toBe(true);
    const change = await handles.prisma.extAuditEvent.findFirstOrThrow({
      where: { kind: "policy.change", actorId: ownerId },
      orderBy: { at: "desc" },
    });
    expect(change.detail).toEqual({ setting: "require2faForAll", value: true });
    const read = await post("/rpc/deployment/get", { json: {} }, owner);
    expect((await json<{ json: { require2faForAll: boolean } }>(read)).json.require2faForAll).toBe(
      true,
    );
  });

  it("with require2faForAll, an unenrolled account reaches only enrolment until it enrols", async () => {
    const late = new Jar();
    expect(
      (
        await post(
          "/api/auth/sign-up/email",
          { email: LATE.email, password: LATE.password, name: "Late" },
          late,
        )
      ).status,
    ).toBeLessThan(400);
    expect(await policy(late)).toEqual({
      enabled: false,
      required: true,
      enforcement: "enrol",
      available: true,
    });
    expect((await me(late)).status).toBe(401);
    expect((await get("/api/v1/audit", late)).status).toBe(401);
    await enrol(late, LATE.password);
    expect(await policy(late)).toMatchObject({ enabled: true, enforcement: "none" });
    expect((await me(late)).status).toBe(200);

    // The owner is never locked out, enrolled or not, and an enrolled member is unaffected.
    expect(await policy(owner)).toMatchObject({ enabled: false, enforcement: "banner" });
    expect((await me(owner)).status).toBe(200);
    expect((await me(member)).status).toBe(200);
  });

  it("exempts test accounts, which also cannot change the policy", async () => {
    const password = "test-account-password-2fa";
    const created = await createTestAccount(handles.prisma, {
      password,
      policyEnv,
      passwordAuth: true,
    });
    if (!created.ok) throw new Error(created.reason);
    const jar = new Jar();
    const signedIn = await signIn({ email: created.value.email, password }, jar);
    expect(signedIn.status).toBe(200);
    expect(await json(signedIn)).not.toHaveProperty("twoFactorRedirect");
    expect(await policy(jar)).toEqual({
      enabled: false,
      required: false,
      enforcement: "none",
      available: true,
    });
    expect((await me(jar)).status).toBe(200);
    const denied = await post("/rpc/deployment/update", { json: { require2faForAll: false } }, jar);
    expect(denied.status).toBe(403);
  });

  it("the host reset removes an account's second factor and trusted devices", async () => {
    const enrolled = await enrol(owner, OWNER.password);
    const device = await pendingSignIn(OWNER);
    await awayFromTotpBoundary();
    await post(
      "/api/auth/two-factor/verify-totp",
      { code: totpCode(enrolled.totpURI), trustDevice: true },
      device,
    );
    expect(
      await handles.prisma.verification.count({
        where: { value: ownerId, identifier: { startsWith: "trust-device-" } },
      }),
    ).toBeGreaterThan(0);

    const { stdout } = await promisify(execFile)(
      "pnpm",
      ["exec", "tsx", "src/cli/reset-2fa.ts", OWNER.email.toUpperCase()],
      {
        cwd: path.resolve(import.meta.dirname, "../../../apps/api"),
        env: {
          ...process.env,
          BETTER_AUTH_SECRET: SECRET,
          ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? "test-encryption-key-test-encryption-key",
          EXT_AUDIT_LOG: "1",
        },
      },
    );
    expect(stdout.trim()).toBe(`reset: ${OWNER.email.toUpperCase()}`);
    expect(
      (await handles.prisma.user.findUniqueOrThrow({ where: { id: ownerId } })).twoFactorEnabled,
    ).toBe(false);
    expect(await handles.prisma.twoFactor.count({ where: { userId: ownerId } })).toBe(0);
    expect(
      await handles.prisma.verification.count({
        where: { value: ownerId, identifier: { startsWith: "trust-device-" } },
      }),
    ).toBe(0);
    const reset = await handles.prisma.extAuditEvent.findFirstOrThrow({
      where: { kind: "auth.2fa_disabled", actorType: "system" },
      orderBy: { at: "desc" },
    });
    expect(reset).toMatchObject({ actorId: "reset-2fa" });
    // Recovery from a lost device also signs the account out everywhere.
    expect((await me(owner)).status).toBe(401);

    const password = new Jar();
    const signedIn = await signIn(OWNER, password);
    expect(signedIn.status).toBe(200);
    expect(await json(signedIn)).not.toHaveProperty("twoFactorRedirect");
    expect(await policy(password)).toMatchObject({ enforcement: "banner" });

    expect(await resetTwoFactor(handles.prisma, OWNER.email)).toEqual({
      ok: true,
      value: { userId: ownerId, status: "not-enrolled" },
    });
    expect(await resetTwoFactor(handles.prisma, "nobody@two-factor.test")).toEqual({
      ok: false,
      reason: "no account has that email",
    });
  });

  const trustedDevices = (userId: string) =>
    handles.prisma.verification.count({
      where: { value: userId, identifier: { startsWith: "trust-device-" } },
    });

  const trustThisDevice = async (totpURI: string) => {
    const laptop = await pendingSignIn(OWNER);
    await awayFromTotpBoundary();
    const verified = await post(
      "/api/auth/two-factor/verify-totp",
      { code: totpCode(totpURI), trustDevice: true },
      laptop,
    );
    expect(verified.status).toBe(200);
    return laptop;
  };

  it("turning two-factor off removes every trusted device, not only this browser's", async () => {
    const browser = new Jar();
    expect((await signIn(OWNER, browser)).status).toBe(200);
    const enrolled = await enrol(browser, OWNER.password);
    const laptop = await trustThisDevice(enrolled.totpURI);
    expect(await trustedDevices(ownerId)).toBeGreaterThan(0);

    await awayFromTotpBoundary();
    const disabled = await post(
      "/api/auth/two-factor/disable",
      { password: OWNER.password, code: totpCode(enrolled.totpURI) },
      browser,
    );
    expect(disabled.status).toBe(200);
    expect(await trustedDevices(ownerId)).toBe(0);

    // Enrolled again, the old laptop's trust cookie no longer skips the code.
    const again = await enrol(browser, OWNER.password);
    await pendingSignIn(OWNER, laptop);
    await awayFromTotpBoundary();
    expect(
      (
        await post(
          "/api/auth/two-factor/disable",
          { password: OWNER.password, code: totpCode(again.totpURI) },
          browser,
        )
      ).status,
    ).toBe(200);
  });

  it("a password change removes trusted devices", async () => {
    const browser = new Jar();
    expect((await signIn(OWNER, browser)).status).toBe(200);
    const enrolled = await enrol(browser, OWNER.password);
    await trustThisDevice(enrolled.totpURI);
    expect(await trustedDevices(ownerId)).toBeGreaterThan(0);

    const changePassword = (from: string, to: string) =>
      post(
        "/api/auth/change-password",
        { currentPassword: from, newPassword: to, revokeOtherSessions: false },
        browser,
      );
    expect((await changePassword(OWNER.password, "owner-new-password-1")).status).toBe(200);
    expect(await trustedDevices(ownerId)).toBe(0);
    expect((await changePassword("owner-new-password-1", OWNER.password)).status).toBe(200);

    await awayFromTotpBoundary();
    expect(
      (
        await post(
          "/api/auth/two-factor/disable",
          { password: OWNER.password, code: totpCode(enrolled.totpURI) },
          browser,
        )
      ).status,
    ).toBe(200);
  });

  it("turning two-factor on signs the account out of its other sessions", async () => {
    const other = new Jar();
    expect((await signIn(MEMBER, other)).status).toBe(200);
    expect((await me(other)).status).toBe(200);
    await enrol(member, MEMBER.password);
    expect((await me(member)).status).toBe(200);
    expect((await me(other)).status).toBe(401);
  });
});
