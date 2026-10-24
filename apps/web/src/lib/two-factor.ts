import { t } from "@lingui/core/macro";
import type { TwoFactorPolicyView } from "@rakazo/contracts";
import { twoFactorPolicySchema } from "@rakazo/contracts";
import { readBoundedJsonResponse } from "@rakazo/core";
import { useEffect, useSyncExternalStore } from "react";
import { authClient } from "./auth";
import { authErrorText } from "./user-error";

/** Servers without two-factor sign-in (desktop can meet an older API). */
const UNAVAILABLE: TwoFactorPolicyView = {
  enabled: false,
  required: false,
  enforcement: "none",
  available: false,
};

export async function fetchTwoFactorPolicy(): Promise<TwoFactorPolicyView> {
  const response = await fetch("/api/auth/two-factor-policy", {
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 404) return UNAVAILABLE;
  if (!response.ok) throw new Error(t`Could not load two-factor settings`);
  return twoFactorPolicySchema.parse(await readBoundedJsonResponse<unknown>(response, 16 * 1024));
}

/** One policy for the banner, the enrolment screen and Settings; any of them can refresh it. */
let current: TwoFactorPolicyView | null = null;
let loadedFor: string | undefined;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: TwoFactorPolicyView | null) {
  current = next;
  for (const listener of listeners) listener();
}

export function refreshTwoFactorPolicy(): Promise<void> {
  loading ??= fetchTwoFactorPolicy()
    .then(publish)
    // A failed read leaves the last known state; the session itself keeps working.
    .catch(() => undefined)
    .finally(() => {
      loading = null;
    });
  return loading;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The signed-in account's two-factor state, loaded once per user and kept current. */
export function useTwoFactorPolicy(): TwoFactorPolicyView | null {
  const userId = authClient.useSession().data?.user.id;
  const policy = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  useEffect(() => {
    if (userId === loadedFor) return;
    loadedFor = userId;
    publish(null);
    if (userId) void refreshTwoFactorPolicy();
  }, [userId]);
  return policy;
}

/** The base32 key inside an otpauth URI, grouped by four for typing into an app by hand. */
export function manualKeyFromUri(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

export function isAuthenticatorCode(code: string): boolean {
  return /^\d{6}$/.test(code.replace(/\s+/g, ""));
}

type AuthResult = { error?: unknown } | null | undefined;

/** Throws the user-facing text when a Better Auth client call fails. */
export function throwOnAuthError(result: AuthResult, fallback: string): void {
  if (result?.error) throw new Error(authErrorText(result.error, fallback));
}

export async function disableTwoFactor(password: string, code: string): Promise<void> {
  const result = await authClient.$fetch("/two-factor/disable", {
    method: "POST",
    body: { password, code: code.trim() },
  });
  throwOnAuthError(result as AuthResult, t`Could not turn off two-factor sign-in`);
}
