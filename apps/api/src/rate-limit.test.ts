import { describe, expect, it } from "vitest";
import {
  clientAddress,
  createRateLimiter,
  isRateLimitExempt,
  loadRateLimitConfig,
  type RateLimitConfig,
  rateLimitClass,
} from "./rate-limit.js";

const config: RateLimitConfig = {
  enabled: true,
  userPerMinute: 6,
  anonPerMinute: 3,
  anonGlobalPerMinute: 5,
  expensivePerMinute: 2,
};

function clock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("rate limiter", () => {
  it("allows a signed-in user up to the limit, then refuses with a retry delay", () => {
    const time = clock();
    const limiter = createRateLimiter(config, time.now);
    for (let i = 0; i < 6; i += 1) {
      expect(limiter.check({ userId: "u1", address: "a", path: "/rpc/me" })).toEqual({ ok: true });
    }
    const refused = limiter.check({ userId: "u1", address: "a", path: "/rpc/me" });
    expect(refused).toEqual({ ok: false, retryAfterSeconds: 10, scope: "user" });
  });

  it("refills over time", () => {
    const time = clock();
    const limiter = createRateLimiter(config, time.now);
    for (let i = 0; i < 6; i += 1) limiter.check({ userId: "u1", address: "a", path: "/rpc/me" });
    expect(limiter.check({ userId: "u1", address: "a", path: "/rpc/me" }).ok).toBe(false);
    time.advance(10_000);
    expect(limiter.check({ userId: "u1", address: "a", path: "/rpc/me" }).ok).toBe(true);
    expect(limiter.check({ userId: "u1", address: "a", path: "/rpc/me" }).ok).toBe(false);
  });

  it("keeps each user's bucket separate", () => {
    const limiter = createRateLimiter(config, clock().now);
    for (let i = 0; i < 6; i += 1) limiter.check({ userId: "u1", address: "a", path: "/rpc/me" });
    expect(limiter.check({ userId: "u1", address: "a", path: "/rpc/me" }).ok).toBe(false);
    expect(limiter.check({ userId: "u2", address: "a", path: "/rpc/me" }).ok).toBe(true);
  });

  it("limits expensive calls separately and more tightly, still counting them as requests", () => {
    const limiter = createRateLimiter(config, clock().now);
    const send = { userId: "u1", address: "a", path: "/rpc/threads/send" };
    expect(limiter.check(send).ok).toBe(true);
    expect(limiter.check(send).ok).toBe(true);
    expect(limiter.check(send)).toEqual({ ok: false, retryAfterSeconds: 30, scope: "expensive" });
    // The two accepted sends used two of the user's six general tokens; a refused one used none.
    for (let i = 0; i < 4; i += 1) {
      expect(limiter.check({ userId: "u1", address: "a", path: "/rpc/me" }).ok).toBe(true);
    }
    expect(limiter.check({ userId: "u1", address: "a", path: "/rpc/me" }).ok).toBe(false);
  });

  it("limits anonymous requests per address and across all addresses", () => {
    const limiter = createRateLimiter(config, clock().now);
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.check({ userId: null, address: "1.1.1.1", path: "/rpc/me" }).ok).toBe(true);
    }
    expect(limiter.check({ userId: null, address: "1.1.1.1", path: "/rpc/me" })).toMatchObject({
      ok: false,
      scope: "address",
    });
    // A spoofed address per request gets past the per-address bucket, not the global one.
    expect(limiter.check({ userId: null, address: "2.2.2.2", path: "/rpc/me" }).ok).toBe(true);
    expect(limiter.check({ userId: null, address: "3.3.3.3", path: "/rpc/me" }).ok).toBe(true);
    expect(limiter.check({ userId: null, address: "4.4.4.4", path: "/rpc/me" })).toMatchObject({
      ok: false,
      scope: "anonymous",
    });
    // Signed-in users are unaffected by anonymous floods.
    expect(limiter.check({ userId: "u1", address: "4.4.4.4", path: "/rpc/me" }).ok).toBe(true);
  });

  it("allows everything when disabled", () => {
    const limiter = createRateLimiter({ ...config, enabled: false }, clock().now);
    for (let i = 0; i < 50; i += 1) {
      expect(limiter.check({ userId: null, address: "a", path: "/rpc/threads/send" }).ok).toBe(
        true,
      );
    }
  });

  it("forgets idle buckets so memory stays bounded", () => {
    const time = clock();
    const limiter = createRateLimiter(config, time.now);
    for (let i = 0; i < 100; i += 1) {
      limiter.check({ userId: `user-${i}`, address: "a", path: "/rpc/me" });
    }
    expect(limiter.size()).toBeGreaterThanOrEqual(100);
    time.advance(11 * 60_000);
    limiter.check({ userId: "fresh", address: "a", path: "/rpc/me" });
    expect(limiter.size()).toBeLessThanOrEqual(3);
  });
});

describe("rate limit classes", () => {
  it.each([
    "/rpc/threads/send",
    "/rpc/computer/uploadFile",
    "/rpc/computer/boot",
    "/rpc/export/bot",
    "/rpc/messaging/link/start",
    "/rpc/bots/create",
    "/rpc/links/favicon",
    "/api/voice/speak",
    "/api/voice/transcribe",
  ])("%s is expensive", (path) => {
    expect(rateLimitClass(path)).toBe("expensive");
  });

  it.each(["/rpc/me", "/rpc/threads/messages", "/api/v1/audit", "/api/v1/control/state"])(
    "%s is a normal request",
    (path) => {
      expect(rateLimitClass(path)).toBe("normal");
    },
  );

  it.each([
    "/api/v1/messaging/webhook/slack",
    "/api/v1/messaging/webhook/teams",
    "/api/v1/bots/abc/webhook",
    "/api/v1/bots/abc/github",
    "/api/v1/phone/webhook",
    "/api/v1/billing/webhook",
  ])("%s is a signed webhook and exempt", (path) => {
    expect(isRateLimitExempt(path)).toBe(true);
  });

  it.each(["/rpc/me", "/api/v1/audit", "/api/v1/bots/abc/webhooks"])("%s is limited", (path) => {
    expect(isRateLimitExempt(path)).toBe(false);
  });
});

describe("client address", () => {
  it("uses the first X-Forwarded-For entry, trimmed", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": " 100.64.1.2 , 127.0.0.1" }))).toBe(
      "100.64.1.2",
    );
  });

  it("falls back to a single shared bucket without the header", () => {
    expect(clientAddress(new Headers())).toBe("unknown");
  });

  it("bounds a hostile header", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": "x".repeat(500) })).length).toBe(64);
  });
});

describe("configuration", () => {
  it("is on in production with the default limits", () => {
    expect(loadRateLimitConfig({ NODE_ENV: "production" })).toEqual({
      enabled: true,
      userPerMinute: 600,
      anonPerMinute: 120,
      anonGlobalPerMinute: 1200,
      expensivePerMinute: 30,
    });
  });

  it("is off outside production unless enabled explicitly", () => {
    expect(loadRateLimitConfig({ NODE_ENV: "development" }).enabled).toBe(false);
    expect(loadRateLimitConfig({ RATE_LIMIT_ENABLED: "1" }).enabled).toBe(true);
    expect(loadRateLimitConfig({ NODE_ENV: "production", RATE_LIMIT_ENABLED: "0" }).enabled).toBe(
      false,
    );
  });

  it("reads limits from the environment and refuses nonsense", () => {
    expect(
      loadRateLimitConfig({ NODE_ENV: "production", RATE_LIMIT_USER_PER_MINUTE: "60" })
        .userPerMinute,
    ).toBe(60);
    expect(() =>
      loadRateLimitConfig({ NODE_ENV: "production", RATE_LIMIT_USER_PER_MINUTE: "0" }),
    ).toThrow(/RATE_LIMIT_USER_PER_MINUTE/);
    expect(() => loadRateLimitConfig({ RATE_LIMIT_ENABLED: "yes" })).toThrow(/RATE_LIMIT_ENABLED/);
  });
});
