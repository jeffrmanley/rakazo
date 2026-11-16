import { describe, expect, it } from "vitest";
import {
  isTwoFactorRedirect,
  normalizeTwoFactorCode,
  readAuthCookie,
  signInRateLimitText,
  twoFactorCodeIssue,
  twoFactorFailure,
} from "./two-factor";

describe("readAuthCookie", () => {
  it("finds a prefixed cookie among others joined by the native networking layer", () => {
    const header = [
      "__Secure-better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; Secure",
      "__Secure-better-auth.two_factor=2fa-x.sig%3D; Max-Age=300; Path=/; HttpOnly; Secure; SameSite=Lax",
    ].join(", ");
    expect(readAuthCookie(header, "two_factor")).toEqual({
      pair: "__Secure-better-auth.two_factor=2fa-x.sig%3D",
      cleared: false,
    });
    expect(readAuthCookie(header, "trust_device")).toBeNull();
  });

  it("reads the unprefixed name a plain-http local server uses", () => {
    expect(readAuthCookie("better-auth.two_factor=abc; Path=/", "two_factor")).toEqual({
      pair: "better-auth.two_factor=abc",
      cleared: false,
    });
  });

  it("is not fooled by the comma inside an Expires date", () => {
    const header =
      "__Secure-better-auth.trust_device=tok!id.sig; Expires=Wed, 16 Dec 2026 10:00:00 GMT; Path=/, other=1; Max-Age=0";
    expect(readAuthCookie(header, "trust_device")).toEqual({
      pair: "__Secure-better-auth.trust_device=tok!id.sig",
      cleared: false,
    });
  });

  it("reports a cleared cookie", () => {
    expect(
      readAuthCookie("__Secure-better-auth.trust_device=; Max-Age=0; Path=/", "trust_device")
        ?.cleared,
    ).toBe(true);
    expect(
      readAuthCookie("better-auth.trust_device=stale; Max-Age=0", "trust_device")?.cleared,
    ).toBe(true);
  });

  it("does not match a lookalike cookie name", () => {
    expect(readAuthCookie("evil-better-auth.two_factor=x; Path=/", "two_factor")).toBeNull();
    expect(readAuthCookie(null, "two_factor")).toBeNull();
  });
});

describe("two-factor input", () => {
  it("recognises the server's code request", () => {
    expect(isTwoFactorRedirect({ twoFactorRedirect: true })).toBe(true);
    expect(isTwoFactorRedirect({ twoFactorRedirect: "true" })).toBe(false);
    expect(isTwoFactorRedirect(null)).toBe(false);
  });

  it("strips spacing from an authenticator code but not from a backup code", () => {
    expect(normalizeTwoFactorCode(" 123 456 ", "totp")).toBe("123456");
    expect(normalizeTwoFactorCode("123-456", "totp")).toBe("123456");
    expect(normalizeTwoFactorCode(" ab-12 ", "backup")).toBe("ab-12");
  });

  it("rejects an empty or malformed authenticator code before any request", () => {
    expect(twoFactorCodeIssue("", "totp")).toBe("Enter the 6-digit code");
    expect(twoFactorCodeIssue("12a456", "totp")).toBe("The code has 6 digits");
    expect(twoFactorCodeIssue("1234567", "totp")).toBe("The code has 6 digits");
    expect(twoFactorCodeIssue("123456", "totp")).toBeNull();
    expect(twoFactorCodeIssue("", "backup")).toBe("Enter a backup code");
    expect(twoFactorCodeIssue("anything", "backup")).toBeNull();
  });
});

describe("two-factor errors", () => {
  const none = new Headers();

  it("keeps the pending sign-in for a wrong code", () => {
    expect(twoFactorFailure(401, none, { code: "INVALID_CODE" }, "totp")).toEqual({
      message: "That code didn’t work. Check your authenticator app and try again.",
      restart: false,
    });
    expect(twoFactorFailure(401, none, { code: "INVALID_BACKUP_CODE" }, "backup")).toEqual({
      message: "That backup code didn’t work. Each backup code works once.",
      restart: false,
    });
  });

  it("restarts for an expired, used-up or locked sign-in", () => {
    for (const [status, code] of [
      [401, "INVALID_TWO_FACTOR_COOKIE"],
      [400, "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE"],
      [429, "ACCOUNT_TEMPORARILY_LOCKED"],
    ] as const) {
      expect(twoFactorFailure(status, none, { code }, "totp").restart, code).toBe(true);
    }
    // Any other 401 means the server no longer knows the pending sign-in.
    expect(twoFactorFailure(401, none, {}, "totp").restart).toBe(true);
  });

  it("reads the wait from either rate-limit header", () => {
    expect(twoFactorFailure(429, new Headers({ "x-retry-after": "3" }), {}, "totp").message).toBe(
      "Too many attempts. Try again in 3 seconds.",
    );
    expect(twoFactorFailure(429, new Headers({ "retry-after": "120" }), {}, "totp").message).toBe(
      "Too many attempts. Try again in 2 minutes.",
    );
    expect(twoFactorFailure(429, none, {}, "totp")).toEqual({
      message: "Too many attempts. Wait a moment and try again.",
      restart: false,
    });
  });

  it("never shows a server's internal error text", () => {
    expect(
      twoFactorFailure(500, none, { message: "PrismaClientKnownRequestError" }, "totp").message,
    ).toBe("Could not check the code");
  });

  it("explains a password sign-in rate limit", () => {
    expect(signInRateLimitText(new Headers({ "x-retry-after": "900" }))).toBe(
      "Too many sign-in attempts. Try again in 15 minutes.",
    );
    expect(signInRateLimitText(none)).toBe(
      "Too many sign-in attempts. Wait a few minutes and try again.",
    );
  });
});
