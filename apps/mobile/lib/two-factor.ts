import { t } from "./i18n";

/**
 * Second-factor sign-in for accounts with an authenticator app (docs/security/two-factor.md).
 *
 * A password sign-in for such an account answers `{ twoFactorRedirect: true }` and a signed
 * `two_factor` cookie instead of a session. The app has no cookie jar (fetch omits credentials),
 * so it keeps that cookie in memory and sends it back with the code. A trusted-device cookie, when
 * the user asks for one, lives in SecureStore and goes with later password sign-ins to the same
 * server, which then skip the code for 30 days.
 */

export type TwoFactorMethod = "totp" | "backup";

/** The server keeps a pending sign-in for 5 minutes (TWO_FACTOR_CHALLENGE_SECONDS). */
export const TWO_FACTOR_CHALLENGE_MS = 5 * 60 * 1000;

export type TwoFactorChallenge = {
  apiBase: string;
  /** `name=value`, exactly as the server set it, for the Cookie header. */
  cookie: string;
  expiresAt: number;
};

type AuthCookieName = "two_factor" | "trust_device";

/** Any character that can start a cookie name in a combined Set-Cookie header. */
const NEXT_COOKIE = /,\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=/g;

/**
 * Reads one Better Auth cookie from a Set-Cookie header. React Native joins repeated headers
 * with ", ", and an `Expires=Wed, 21 Oct …` attribute holds a comma too; a cookie boundary is a
 * comma followed by `name=`, which a date never is.
 */
export function readAuthCookie(
  setCookie: string | null | undefined,
  name: AuthCookieName,
): { pair: string; cleared: boolean } | null {
  if (!setCookie) return null;
  const start = new RegExp(`(?:^|,\\s*)((?:__Secure-)?better-auth\\.${name})=([^;,]*)`).exec(
    setCookie,
  );
  if (!start) return null;
  const [, cookieName, value = ""] = start;
  const rest = setCookie.slice(start.index + start[0].length);
  NEXT_COOKIE.lastIndex = 0;
  const boundary = NEXT_COOKIE.exec(rest);
  const attributes = boundary ? rest.slice(0, boundary.index) : rest;
  const cleared = !value || /;\s*max-age=(?:0|-\d+)\s*(?:;|$)/i.test(attributes);
  return { pair: `${cookieName}=${value}`, cleared };
}

export function isTwoFactorRedirect(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { twoFactorRedirect?: unknown }).twoFactorRedirect === true
  );
}

/** Normalises what the user typed: spaces and dashes are presentation, not part of a code. */
export function normalizeTwoFactorCode(input: string, method: TwoFactorMethod): string {
  const trimmed = input.trim();
  return method === "totp" ? trimmed.replace(/[\s-]/g, "") : trimmed;
}

export function twoFactorCodeIssue(code: string, method: TwoFactorMethod): string | null {
  if (!code) {
    return method === "totp" ? t("Enter the 6-digit code") : t("Enter a backup code");
  }
  if (method === "totp" && !/^\d{6}$/.test(code)) return t("The code has 6 digits");
  return null;
}

/** The pending sign-in is gone; the user has to enter the password again. */
export class TwoFactorRestartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwoFactorRestartError";
  }
}

function retryAfterSeconds(headers: Headers): number | null {
  for (const name of ["retry-after", "x-retry-after"]) {
    const raw = headers.get(name);
    if (raw === null) continue;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  }
  return null;
}

function waitText(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 90) return t("{count} seconds", { count: seconds });
  return t("{count} minutes", { count: Math.ceil(seconds / 60) });
}

/** Copy for a 429 on password sign-in (10 attempts per 15 minutes in production). */
export function signInRateLimitText(headers: Headers): string {
  const wait = waitText(retryAfterSeconds(headers));
  return wait
    ? t("Too many sign-in attempts. Try again in {wait}.", { wait })
    : t("Too many sign-in attempts. Wait a few minutes and try again.");
}

function errorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Maps a failed code check to copy. `restart` means the pending sign-in no longer exists (it
 * expired, used its five codes, or the account locked), so the password step comes back.
 */
export function twoFactorFailure(
  status: number,
  headers: Headers,
  body: unknown,
  method: TwoFactorMethod,
): { message: string; restart: boolean } {
  const code = errorCode(body);
  if (code === "ACCOUNT_TEMPORARILY_LOCKED") {
    return {
      message: t("Too many wrong codes. Two-factor sign-in is locked for 15 minutes."),
      restart: true,
    };
  }
  if (status === 429) {
    const wait = waitText(retryAfterSeconds(headers));
    return {
      message: wait
        ? t("Too many attempts. Try again in {wait}.", { wait })
        : t("Too many attempts. Wait a moment and try again."),
      restart: false,
    };
  }
  if (code === "INVALID_CODE") {
    return {
      message: t("That code didn’t work. Check your authenticator app and try again."),
      restart: false,
    };
  }
  if (code === "INVALID_BACKUP_CODE") {
    return {
      message: t("That backup code didn’t work. Each backup code works once."),
      restart: false,
    };
  }
  if (code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE") {
    return {
      message: t("Too many wrong codes for this sign-in. Enter your password again."),
      restart: true,
    };
  }
  if (code === "INVALID_TWO_FACTOR_COOKIE" || status === 401) {
    return { message: t("This sign-in expired. Enter your password again."), restart: true };
  }
  return {
    message:
      method === "totp" ? t("Could not check the code") : t("Could not check the backup code"),
    restart: false,
  };
}
