import { randomBytes } from "node:crypto";
import type { PrismaClient, SignupPolicyEnv } from "@rakazo/db";
import { bootstrapUserSpace } from "@rakazo/db";
import { hashPassword } from "better-auth/crypto";

/**
 * Throwaway accounts for acceptance checks against a running deployment (docs/test-accounts.md).
 * The addresses live under the reserved `.invalid` domain, which sign-up, OIDC and email changes
 * refuse, so only this module creates them and nothing here touches an account outside it.
 */
const TEST_ACCOUNT_EMAIL = /^live-test-[0-9a-f]{12}@live-test\.invalid$/;
export const TEST_ACCOUNT_DOMAIN = "live-test.invalid";
const MAX_LISTED = 100;

export type TestAccountResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export function isTestAccountEmail(email: string): boolean {
  return TEST_ACCOUNT_EMAIL.test(email);
}

/** Any address in the reserved domain or below it, in any case: never available to people. */
export function isReservedTestAccountEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@").at(-1) ?? "";
  return (
    email.includes("@") &&
    (domain === TEST_ACCOUNT_DOMAIN || domain.endsWith(`.${TEST_ACCOUNT_DOMAIN}`))
  );
}

export function newTestAccountEmail(): string {
  return `live-test-${randomBytes(6).toString("hex")}@${TEST_ACCOUNT_DOMAIN}`;
}

/** Undefined when the password is acceptable, otherwise why it is not. */
export function checkTestAccountPassword(password: string): string | undefined {
  if (!password) return "a password is required on stdin";
  if (/[\r\n]/.test(password)) return "the password must be one line";
  if (!/^[\x21-\x7e]*$/.test(password)) return "the password must be printable ASCII, no spaces";
  if (password.length < 16) return "the password needs at least 16 characters";
  if (password.length > 128) return "the password allows at most 128 characters";
  return undefined;
}

/**
 * A verified user with a password login and a personal space of its own. It never claims the
 * deployment owner and leaves the sign-up policy as it is. Refused until the deployment has an
 * owner, so a test account can never stand where the first real account should.
 */
export async function createTestAccount(
  prisma: PrismaClient,
  input: { password: string; policyEnv: SignupPolicyEnv; passwordAuth: boolean },
): Promise<TestAccountResult<{ email: string; userId: string; spaceId: string }>> {
  const refused = checkTestAccountPassword(input.password);
  if (refused) return { ok: false, reason: refused };
  if (!input.passwordAuth) {
    return { ok: false, reason: "password sign-in is disabled on this deployment" };
  }
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { ownerUserId: true },
  });
  if (!settings?.ownerUserId) {
    return { ok: false, reason: "the deployment has no owner yet; sign up as the owner first" };
  }
  const email = newTestAccountEmail();
  const userId = randomBytes(16).toString("hex");
  const passwordHash = await hashPassword(input.password);
  await prisma.$transaction(async (tx) => {
    await tx.user.create({
      data: { id: userId, email, name: "Live test", emailVerified: true },
    });
    await tx.account.create({
      data: {
        id: randomBytes(16).toString("hex"),
        accountId: userId,
        providerId: "credential",
        userId,
        password: passwordHash,
      },
    });
  });
  try {
    const { spaceId } = await bootstrapUserSpace(prisma, { id: userId }, input.policyEnv, {
      claimDeploymentOwner: false,
    });
    return { ok: true, value: { email, userId, spaceId } };
  } catch (error) {
    // Without its space the account could neither sign in nor be deleted through the API.
    // Nothing else references it yet; the organization takes its space and memberships along.
    await prisma.organization.deleteMany({ where: { slug: `user-${userId.slice(0, 12)}` } });
    await prisma.user.deleteMany({ where: { id: userId } });
    throw error;
  }
}

export async function listTestAccounts(
  prisma: PrismaClient,
): Promise<Array<{ email: string; createdAt: Date }>> {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: "live-test-", endsWith: `@${TEST_ACCOUNT_DOMAIN}` } },
    select: { email: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: MAX_LISTED,
  });
  return users.filter((user) => isTestAccountEmail(user.email));
}

/**
 * Deletes through the running API's `POST /api/auth/delete-user`, so bots, spaces and sessions go
 * exactly as when a person deletes their account. The password is replaced first, so this works
 * without the one the account was created with.
 */
export async function deleteTestAccount(
  prisma: PrismaClient,
  input: {
    email: string;
    webOrigin: string;
    request: (path: string, init: RequestInit) => Promise<Response>;
  },
): Promise<TestAccountResult<"deleted" | "absent">> {
  if (!isTestAccountEmail(input.email)) {
    return { ok: false, reason: "not a test account address" };
  }
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });
  if (!user) return { ok: true, value: "absent" };
  const password = randomBytes(24).toString("base64url");
  const reset = await prisma.account.updateMany({
    where: { userId: user.id, providerId: "credential" },
    data: { password: await hashPassword(password) },
  });
  if (reset.count !== 1) return { ok: false, reason: "the account has no password login" };

  const post = (path: string, body: unknown, cookie?: string) =>
    input.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: input.webOrigin,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  const signedIn = await post("/api/auth/sign-in/email", { email: input.email, password });
  if (signedIn.status === 429) {
    return { ok: false, reason: "sign-in is rate limited; try again in 15 minutes" };
  }
  if (!signedIn.ok) return { ok: false, reason: `sign-in failed with ${signedIn.status}` };
  const cookie = signedIn.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const deleted = await post("/api/auth/delete-user", { password }, cookie);
  if (!deleted.ok) return { ok: false, reason: `delete-user failed with ${deleted.status}` };
  const remaining = await prisma.user.count({ where: { id: user.id } });
  if (remaining !== 0) return { ok: false, reason: "the account still exists after delete-user" };
  return { ok: true, value: "deleted" };
}
