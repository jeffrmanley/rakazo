import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import {
  checkTestAccountPassword,
  createTestAccount,
  deleteTestAccount,
  isReservedTestAccountEmail,
  isTestAccountEmail,
  newTestAccountEmail,
} from "./test-accounts.js";

/** Any database access fails the test: refused input must be rejected before the database. */
const untouchable = new Proxy({} as PrismaClient, {
  get: (_target, property) => {
    throw new Error(`database touched: ${String(property)}`);
  },
});
const refuseRequests = async () => {
  throw new Error("HTTP request made");
};
const policyEnv = { signupsEnabled: "true", signupAllowlist: "@allowed.test" };

describe("test account addresses", () => {
  it("generates addresses that match the reserved pattern and differ each time", () => {
    const first = newTestAccountEmail();
    expect(first).toMatch(/^live-test-[0-9a-f]{12}@live-test\.invalid$/);
    expect(isTestAccountEmail(first)).toBe(true);
    expect(newTestAccountEmail()).not.toBe(first);
  });

  it.each([
    "owner@example.com",
    "live-test-0123456789ab@example.com",
    "live-test-0123456789ab@live-test.invalid.example.com",
    "LIVE-TEST-0123456789AB@LIVE-TEST.INVALID",
    "live-test-0123456789a@live-test.invalid",
    "live-test-0123456789abc@live-test.invalid",
    "live-test-0123456789ag@live-test.invalid",
    " live-test-0123456789ab@live-test.invalid",
    "live-test-0123456789ab@live-test.invalid\n",
    "x+live-test-0123456789ab@live-test.invalid",
    "msg-0123456789ab@messaging.invalid",
    "",
  ])("refuses %j", (email) => {
    expect(isTestAccountEmail(email)).toBe(false);
  });
});

describe("reserved test account domain", () => {
  it.each([
    "live-test-0123456789ab@live-test.invalid",
    "anyone@live-test.invalid",
    "Anyone@LIVE-TEST.INVALID",
    "x@sub.live-test.invalid",
    " x@live-test.invalid ",
  ])("reserves %j", (email) => {
    expect(isReservedTestAccountEmail(email)).toBe(true);
  });

  it.each([
    "x@live-test.invalid.example.com",
    "x@notlive-test.invalid",
    "x@example.com",
    "live-test.invalid",
  ])("leaves %j alone", (email) => {
    expect(isReservedTestAccountEmail(email)).toBe(false);
  });
});

describe("test account passwords", () => {
  it.each([
    ["", "required"],
    ["short-password1", "16"],
    ["x".repeat(129), "128"],
    ["has a\nnewline-inside", "one line"],
    ["has spaces in the middle", "printable ASCII"],
    ["pässwörd-with-umlauts", "printable ASCII"],
    ["\u20ac".repeat(20), "printable ASCII"],
  ])("refuses %j", (password, reason) => {
    expect(checkTestAccountPassword(password)).toContain(reason);
  });

  it("accepts 16 to 128 characters", () => {
    expect(checkTestAccountPassword("a".repeat(16))).toBeUndefined();
    expect(checkTestAccountPassword("a".repeat(128))).toBeUndefined();
  });
});

describe("refused input never reaches the database", () => {
  it("create refuses a bad password", async () => {
    const result = await createTestAccount(untouchable, {
      password: "short",
      policyEnv,
      passwordAuth: true,
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("16") });
  });

  it("create refuses when password sign-in is disabled", async () => {
    const result = await createTestAccount(untouchable, {
      password: "a-long-enough-password",
      policyEnv,
      passwordAuth: false,
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("disabled") });
  });

  it.each(["owner@example.com", "live-test-0123456789ab@example.com"])(
    "delete refuses %s",
    async (email) => {
      const result = await deleteTestAccount(untouchable, {
        email,
        webOrigin: "http://127.0.0.1:5173",
        request: refuseRequests,
      });
      expect(result).toEqual({ ok: false, reason: expect.stringContaining("not a test account") });
    },
  );
});
