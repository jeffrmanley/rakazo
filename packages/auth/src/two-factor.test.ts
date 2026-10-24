import { describe, expect, it } from "vitest";
import {
  backupCodeDigest,
  hashedBackupCodeStorage,
  TWO_FACTOR_CHALLENGE_SECONDS,
  twoFactorPolicy,
} from "./two-factor.js";

const owner = {
  userId: "owner",
  email: "owner@example.com",
  twoFactorEnabled: false,
  hasPassword: true,
  ownerUserId: "owner",
  require2faForAll: false,
};

describe("twoFactorPolicy", () => {
  it("asks the owner to enrol with a banner, never a lockout", () => {
    expect(twoFactorPolicy(owner)).toEqual({
      enabled: false,
      required: true,
      enforcement: "banner",
      available: true,
    });
    expect(twoFactorPolicy({ ...owner, require2faForAll: true }).enforcement).toBe("banner");
  });

  it("clears the banner once the owner has enrolled", () => {
    expect(twoFactorPolicy({ ...owner, twoFactorEnabled: true })).toEqual({
      enabled: true,
      required: true,
      enforcement: "none",
      available: true,
    });
  });

  it("leaves other accounts alone until require2faForAll is on", () => {
    const member = { ...owner, userId: "member", email: "member@example.com" };
    expect(twoFactorPolicy(member)).toMatchObject({ required: false, enforcement: "none" });
    expect(twoFactorPolicy({ ...member, require2faForAll: true })).toMatchObject({
      required: true,
      enforcement: "enrol",
    });
    expect(
      twoFactorPolicy({ ...member, require2faForAll: true, twoFactorEnabled: true }),
    ).toMatchObject({ required: true, enforcement: "none" });
  });

  it.each([
    "live-test-0123456789ab@live-test.invalid",
    "Someone@LIVE-TEST.INVALID",
    "x@sub.live-test.invalid",
  ])("exempts the test account %s, even as owner or with require2faForAll", (email) => {
    expect(twoFactorPolicy({ ...owner, email, require2faForAll: true })).toMatchObject({
      required: false,
      enforcement: "none",
    });
    expect(twoFactorPolicy({ ...owner, userId: "t", email, require2faForAll: true })).toMatchObject(
      { required: false, enforcement: "none" },
    );
  });

  it("exempts messaging identities", () => {
    expect(
      twoFactorPolicy({ ...owner, email: "bot-1@messaging.invalid", require2faForAll: true }),
    ).toMatchObject({ required: false, enforcement: "none" });
  });

  it("does not require it of an account without a password: its identity provider signs it in", () => {
    expect(twoFactorPolicy({ ...owner, hasPassword: false, require2faForAll: true })).toEqual({
      enabled: false,
      required: false,
      enforcement: "none",
      available: false,
    });
  });

  it("does not treat a missing owner as a match", () => {
    expect(twoFactorPolicy({ ...owner, ownerUserId: null })).toMatchObject({
      required: false,
      enforcement: "none",
    });
  });
});

describe("hashed backup code storage", () => {
  const secret = "test-secret-test-secret-32chars!";
  const storage = hashedBackupCodeStorage(secret);

  it("stores keyed digests, never the codes", async () => {
    const codes = ["AbCdE-12345", "zzzzz-00000"];
    const stored = await storage.encrypt(JSON.stringify(codes));
    for (const code of codes) expect(stored).not.toContain(code);
    expect(JSON.parse(stored)).toEqual(codes.map((code) => backupCodeDigest(secret, code)));
  });

  it("keeps digests as they are when the plugin rewrites the remaining codes", async () => {
    const digests = [backupCodeDigest(secret, "AbCdE-12345")];
    const stored = await storage.encrypt(JSON.stringify(digests));
    expect(JSON.parse(stored)).toEqual(digests);
    expect(await storage.decrypt(stored)).toBe(stored);
  });

  it("depends on the auth secret and ignores surrounding space", () => {
    expect(backupCodeDigest(secret, " AbCdE-12345\n")).toBe(
      backupCodeDigest(secret, "AbCdE-12345"),
    );
    expect(backupCodeDigest(secret, "AbCdE-12345")).not.toBe(
      backupCodeDigest("another-secret-another-secret-32", "AbCdE-12345"),
    );
    expect(backupCodeDigest(secret, "AbCdE-12345")).not.toBe(
      backupCodeDigest(secret, "abcde-12345"),
    );
  });

  it("never accepts a stored digest as if it were a code", () => {
    const digest = backupCodeDigest(secret, "AbCdE-12345");
    expect(backupCodeDigest(secret, digest)).not.toBe(digest);
  });
});

it("gives a pending sign-in five minutes", () => {
  expect(TWO_FACTOR_CHALLENGE_SECONDS).toBe(300);
});
