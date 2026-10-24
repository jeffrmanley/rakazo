import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTwoFactorPolicy, isAuthenticatorCode, manualKeyFromUri } from "./two-factor";

vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
}));
vi.mock("./auth", () => ({ authClient: { useSession: () => ({ data: null }), $fetch: vi.fn() } }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("two-factor helpers", () => {
  it("groups the otpauth key by four for typing by hand", () => {
    expect(
      manualKeyFromUri(
        "otpauth://totp/Crew:a%40b.c?secret=GEZDGNBVGY3TQOJQGEZD&issuer=Crew&digits=6&period=30",
      ),
    ).toBe("GEZD GNBV GY3T QOJQ GEZD");
  });

  it.each([
    ["123456", true],
    ["123 456", true],
    ["12345", false],
    ["1234567", false],
    ["AbCdE-12345", false],
  ])("treats %s as an authenticator code: %s", (code, expected) => {
    expect(isAuthenticatorCode(code)).toBe(expected);
  });

  it("reads the policy, and treats a server without it as unavailable", async () => {
    const policy = { enabled: false, required: true, enforcement: "banner", available: true };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(policy), { status: 200 })),
    );
    await expect(fetchTwoFactorPolicy()).resolves.toEqual(policy);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    await expect(fetchTwoFactorPolicy()).resolves.toEqual({
      enabled: false,
      required: false,
      enforcement: "none",
      available: false,
    });
  });

  it("fails on an error or a malformed answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    await expect(fetchTwoFactorPolicy()).rejects.toThrow("Could not load two-factor settings");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ enforcement: "maybe" }), { status: 200 })),
    );
    await expect(fetchTwoFactorPolicy()).rejects.toThrow();
  });
});
