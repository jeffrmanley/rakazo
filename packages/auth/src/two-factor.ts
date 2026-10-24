import { createHmac } from "node:crypto";
import { isMessagingEmail } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getIP,
  isAPIError,
  sessionMiddleware,
} from "better-auth/api";
import type { TwoFactorOptions } from "better-auth/plugins/two-factor";
import { sessionForAuthHook } from "./account-security.js";
import { isReservedTestAccountEmail } from "./test-accounts.js";

/**
 * Authenticator-app two-factor sign-in (docs/security/two-factor.md), on Better Auth's
 * `two-factor` plugin. This module adds the deployment policy (the owner must enrol;
 * `require2faForAll` extends that to everyone), hashed backup codes, a current code to
 * disable, and the events the API logs and audits.
 */

/** A pending sign-in lives this long; the plugin allows five codes per pending sign-in. */
export const TWO_FACTOR_CHALLENGE_SECONDS = 5 * 60;
const TRUST_DEVICE_SECONDS = 30 * 24 * 60 * 60;
const VERIFY_PATHS = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);
const PENDING_USER = "rakazoTwoFactorUserId";
const DIGEST_PREFIX = "hmac-sha256:";

export type TwoFactorEnforcement = "none" | "banner" | "enrol";

export interface TwoFactorPolicy {
  enabled: boolean;
  required: boolean;
  /** For a required account that has not enrolled: the owner gets a banner, others the enrolment screen. */
  enforcement: TwoFactorEnforcement;
  /** Two-factor guards password sign-in, so an account without a password has nothing to enrol. */
  available: boolean;
}

export type TwoFactorEvent =
  | { kind: "enabled" | "disabled"; userId: string; ip: string | null }
  | { kind: "failed"; userId: string | null; ip: string | null; reason: string };

export function twoFactorPolicy(input: {
  userId: string;
  email: string;
  twoFactorEnabled: boolean;
  hasPassword: boolean;
  ownerUserId: string | null;
  require2faForAll: boolean;
}): TwoFactorPolicy {
  const exempt =
    !input.hasPassword || isReservedTestAccountEmail(input.email) || isMessagingEmail(input.email);
  const owner = input.ownerUserId !== null && input.ownerUserId === input.userId;
  const required = !exempt && (owner || input.require2faForAll);
  const enforcement: TwoFactorEnforcement =
    !required || input.twoFactorEnabled ? "none" : owner ? "banner" : "enrol";
  return { enabled: input.twoFactorEnabled, required, enforcement, available: input.hasPassword };
}

type PolicyUser = { id: string; email: string; twoFactorEnabled?: boolean | null };

export async function loadTwoFactorPolicy(
  prisma: Pick<PrismaClient, "deploymentSettings" | "account">,
  user: PolicyUser,
): Promise<TwoFactorPolicy> {
  const [settings, credential] = await Promise.all([
    prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true, require2faForAll: true },
    }),
    prisma.account.findFirst({
      where: { userId: user.id, providerId: "credential", password: { not: null } },
      select: { id: true },
    }),
  ]);
  return twoFactorPolicy({
    userId: user.id,
    email: user.email,
    twoFactorEnabled: user.twoFactorEnabled === true,
    hasPassword: credential !== null,
    ownerUserId: settings?.ownerUserId ?? null,
    require2faForAll: settings?.require2faForAll ?? false,
  });
}

/** True when the deployment requires this signed-in account to enrol before it uses the product. */
export async function twoFactorEnrolmentPending(
  prisma: Pick<PrismaClient, "deploymentSettings" | "account">,
  user: PolicyUser,
): Promise<boolean> {
  if (user.twoFactorEnabled === true) return false;
  // Runs on every API request of an unenrolled account: one read unless the policy is on.
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { require2faForAll: true },
  });
  if (!settings?.require2faForAll) return false;
  return (await loadTwoFactorPolicy(prisma, user)).enforcement === "enrol";
}

/**
 * Backup codes have about 60 bits of entropy, so a keyed SHA-256 is enough and a database
 * copy alone cannot be checked offline. Codes are compared after the same digest, so the
 * value stored for a code never works as a code.
 */
export function backupCodeDigest(secret: string, code: string): string {
  const mac = createHmac("sha256", secret).update(`two-factor-backup-code\0${code.trim()}`);
  return `${DIGEST_PREFIX}${mac.digest("base64url")}`;
}

/**
 * The plugin's storage hook: it encodes the fresh codes and, after one is used, the remaining
 * entries, which are digests by then. Its own check is set membership, which works on digests
 * because the verify hook below replaces the submitted code with its digest.
 */
export function hashedBackupCodeStorage(secret: string) {
  return {
    encrypt: async (json: string) => {
      const codes: unknown = JSON.parse(json);
      if (!Array.isArray(codes)) throw new TypeError("backup codes must be a list");
      return JSON.stringify(
        codes.map((code) => {
          const value = String(code);
          return value.startsWith(DIGEST_PREFIX) ? value : backupCodeDigest(secret, value);
        }),
      );
    },
    decrypt: async (stored: string) => stored,
  };
}

export function twoFactorOptions(secret: string): TwoFactorOptions {
  return {
    twoFactorCookieMaxAge: TWO_FACTOR_CHALLENGE_SECONDS,
    trustDeviceMaxAge: TRUST_DEVICE_SECONDS,
    totpOptions: { digits: 6, period: 30 },
    backupCodeOptions: { amount: 10, storeBackupCodes: hashedBackupCodeStorage(secret) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/** The account behind a verification: the session's, or the pending sign-in's. */
async function verifyingUserId(ctx: HookContext): Promise<string | null> {
  const session = await sessionForAuthHook(ctx).catch(() => null);
  if (session) return session.user.id;
  const cookie = ctx.context.createAuthCookie("two_factor");
  const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!identifier) return null;
  const pending = await ctx.context.internalAdapter.findVerificationValue(identifier);
  return pending?.value ?? null;
}

function requestIp(ctx: HookContext): string | null {
  const source = ctx.request ?? ctx.headers;
  return source ? getIP(source, ctx.context.options) : null;
}

export function twoFactorGuard(deps: {
  prisma: Pick<PrismaClient, "deploymentSettings" | "account">;
  secret: string;
  brandName: () => Promise<string>;
  /** Checks a current authenticator code, or a backup code, for the session in `headers`. */
  verifyCode: (headers: Headers, code: string) => Promise<void>;
  onEvent?: (event: TwoFactorEvent) => Promise<void>;
}): BetterAuthPlugin {
  const emit = async (event: TwoFactorEvent) => {
    await deps.onEvent?.(event);
  };
  return {
    id: "two-factor-policy",
    endpoints: {
      getTwoFactorPolicy: createAuthEndpoint(
        "/two-factor-policy",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx) => {
          const user = ctx.context.session.user as PolicyUser;
          ctx.setHeader("cache-control", "no-store");
          return ctx.json(await loadTwoFactorPolicy(deps.prisma, user));
        },
      ),
    },
    init: () => ({
      options: {
        databaseHooks: {
          user: {
            update: {
              // The plugin flips this flag only when a first code confirms enrolment and when
              // the account disables two-factor; those are the two events worth an audit row.
              after: async (user, ctx) => {
                const enabled = (user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled;
                const ip = ctx ? requestIp(ctx as HookContext) : null;
                if (ctx?.path === "/two-factor/verify-totp" && enabled === true) {
                  await emit({ kind: "enabled", userId: user.id, ip });
                } else if (ctx?.path === "/two-factor/disable" && enabled === false) {
                  await emit({ kind: "disabled", userId: user.id, ip });
                }
              },
            },
          },
        },
      },
    }),
    hooks: {
      before: [
        {
          // The authenticator shows the product's current name, not a client-chosen one.
          matcher: (ctx) => ctx.path === "/two-factor/enable",
          handler: createAuthMiddleware(async (ctx) => {
            const body = isRecord(ctx.body) ? ctx.body : {};
            return { context: { body: { ...body, issuer: await deps.brandName() } } };
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/two-factor/disable",
          handler: createAuthMiddleware(async (ctx) => {
            const session = await sessionForAuthHook(ctx);
            if (!session) throw new APIError("UNAUTHORIZED");
            const code = typeof ctx.body?.code === "string" ? ctx.body.code.trim() : "";
            if (!code) {
              throw new APIError("BAD_REQUEST", {
                code: "TWO_FACTOR_CODE_REQUIRED",
                message: "Enter a code from your authenticator app or a backup code",
              });
            }
            await deps.verifyCode(ctx.headers ?? new Headers(), code);
          }),
        },
        {
          matcher: (ctx) => VERIFY_PATHS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const userId = await verifyingUserId(ctx);
            const context = { [PENDING_USER]: userId };
            if (ctx.path !== "/two-factor/verify-backup-code" || typeof ctx.body?.code !== "string")
              return { context: { context } };
            return {
              context: {
                context,
                body: { ...ctx.body, code: backupCodeDigest(deps.secret, ctx.body.code) },
              },
            };
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => VERIFY_PATHS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            if (!isAPIError(returned)) return;
            const pending = (ctx.context as unknown as Record<string, unknown>)[PENDING_USER];
            const code = isRecord(returned.body) ? returned.body.code : undefined;
            await emit({
              kind: "failed",
              userId: typeof pending === "string" ? pending : null,
              ip: requestIp(ctx),
              reason: typeof code === "string" ? code : String(returned.status),
            });
          }),
        },
      ],
    },
  };
}

/**
 * Host-operator recovery (apps/api/src/cli/reset-2fa.ts): removes the account's second factor,
 * its trusted devices and any pending sign-in, so the next password sign-in needs no code.
 * Sessions stay; the deployment policy asks the account to enrol again.
 */
export async function resetTwoFactor(
  prisma: PrismaClient,
  email: string,
): Promise<
  | { ok: true; value: { userId: string; status: "reset" | "not-enrolled" } }
  | { ok: false; reason: string }
> {
  const user = await prisma.user.findFirst({
    where: { email: { equals: email.trim(), mode: "insensitive" } },
    select: { id: true, twoFactorEnabled: true },
  });
  if (!user) return { ok: false, reason: "no account has that email" };
  const removed = await prisma.$transaction(async (tx) => {
    const factors = await tx.twoFactor.deleteMany({ where: { userId: user.id } });
    await tx.user.update({ where: { id: user.id }, data: { twoFactorEnabled: false } });
    await tx.verification.deleteMany({
      where: {
        value: user.id,
        OR: [
          { identifier: { startsWith: "trust-device-" } },
          { identifier: { startsWith: "2fa-" } },
        ],
      },
    });
    return factors.count;
  });
  return {
    ok: true,
    value: {
      userId: user.id,
      status: removed > 0 || user.twoFactorEnabled === true ? "reset" : "not-enrolled",
    },
  };
}
