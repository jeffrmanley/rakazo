import { randomUUID } from "node:crypto";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";

/**
 * API-wide request limits (hardening phase 1). Sign-in has its own limiter in better-auth; this
 * covers the RPC and REST surface. Token buckets in memory: the deployment runs one API process.
 *
 * - Signed in: one bucket per user, plus a tighter one per user for calls that start work or
 *   call out (chat send, uploads, exports, …).
 * - Anonymous: one bucket per client address, plus one shared by every anonymous request, so
 *   a client inventing a new address per request still cannot flood the database.
 * - Webhooks (public through the tunnel, signed by their senders): a generous bucket per client
 *   address plus one shared by all webhook traffic, apart from users' buckets so a flood of
 *   webhooks never slows the app, and a sender's retries are not cut short.
 */
export interface RateLimitConfig {
  enabled: boolean;
  userPerMinute: number;
  anonPerMinute: number;
  anonGlobalPerMinute: number;
  expensivePerMinute: number;
  webhookPerMinute: number;
  webhookGlobalPerMinute: number;
}

export type RateLimitScope =
  | "user"
  | "expensive"
  | "address"
  | "anonymous"
  | "webhook"
  | "webhooks";

export type RateLimitDecision =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number; scope: RateLimitScope };

const EXPENSIVE_PATHS = new Set([
  "/rpc/threads/send",
  "/rpc/computer/uploadFile",
  "/rpc/computer/boot",
  "/rpc/export/bot",
  "/rpc/messaging/link/start",
  "/rpc/bots/create",
  "/rpc/spaces/create",
  "/rpc/groups/create",
  "/rpc/routines/create",
  "/rpc/models/connect",
  "/rpc/links/favicon",
  "/rpc/artifacts/create",
  "/rpc/brand/uploadLogo",
  "/api/voice/speak",
  "/api/voice/transcribe",
]);

const WEBHOOK_PATTERNS = [
  /^\/api\/v1\/messaging\/webhook\/[^/]+$/,
  /^\/api\/v1\/bots\/[^/]+\/(webhook|github)$/,
  /^\/api\/v1\/phone\/webhook$/,
  /^\/api\/v1\/billing\/webhook$/,
];

/** oRPC and Hono both ignore trailing slashes, so classification must too. */
function normalizePath(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

export function rateLimitClass(path: string): "expensive" | "webhook" | "normal" {
  const normalized = normalizePath(path);
  if (WEBHOOK_PATTERNS.some((pattern) => pattern.test(normalized))) return "webhook";
  return EXPENSIVE_PATHS.has(normalized) ? "expensive" : "normal";
}

/**
 * The client as the front end reports it. The header can be forged, which only lets an
 * anonymous client pick its own per-address bucket; the shared anonymous bucket still applies.
 */
export function clientAddress(headers: Headers): string {
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first ? first.slice(0, 64) : "unknown";
}

const IDLE_MS = 10 * 60_000;
const PRUNE_EVERY_MS = 60_000;
const MAX_BUCKETS = 100_000;

type Bucket = { tokens: number; updatedAt: number };

export function createRateLimiter(config: RateLimitConfig, now: () => number = Date.now) {
  const buckets = new Map<string, Bucket>();
  let prunedAt = now();

  const prune = (at: number) => {
    for (const [key, bucket] of buckets) {
      if (at - bucket.updatedAt > IDLE_MS) buckets.delete(key);
    }
    // Still too many live buckets (a flood of distinct keys): start over rather than grow.
    if (buckets.size > MAX_BUCKETS) buckets.clear();
    prunedAt = at;
  };

  /** Refills the bucket to `at` and reports the wait before one token is available. */
  const peek = (key: string, perMinute: number, at: number) => {
    const rate = perMinute / 60_000;
    const bucket = buckets.get(key) ?? { tokens: perMinute, updatedAt: at };
    bucket.tokens = Math.min(perMinute, bucket.tokens + (at - bucket.updatedAt) * rate);
    bucket.updatedAt = at;
    buckets.set(key, bucket);
    return bucket.tokens >= 1 ? 0 : Math.ceil((1 - bucket.tokens) / rate / 1000);
  };

  return {
    check(request: { userId: string | null; address: string; path: string }): RateLimitDecision {
      if (!config.enabled) return { ok: true };
      const at = now();
      if (at - prunedAt >= PRUNE_EVERY_MS) prune(at);
      const kind = rateLimitClass(request.path);
      const expensive = kind === "expensive";
      const checks: Array<{ key: string; perMinute: number; scope: RateLimitScope }> =
        kind === "webhook"
          ? [
              { key: `w:${request.address}`, perMinute: config.webhookPerMinute, scope: "webhook" },
              { key: "webhooks", perMinute: config.webhookGlobalPerMinute, scope: "webhooks" },
            ]
          : request.userId
            ? [{ key: `u:${request.userId}`, perMinute: config.userPerMinute, scope: "user" }]
            : [
                { key: `a:${request.address}`, perMinute: config.anonPerMinute, scope: "address" },
                { key: "anon", perMinute: config.anonGlobalPerMinute, scope: "anonymous" },
              ];
      if (expensive) {
        checks.unshift({
          key: `x:${request.userId ?? `a:${request.address}`}`,
          perMinute: config.expensivePerMinute,
          scope: "expensive",
        });
      }
      for (const { key, perMinute, scope } of checks) {
        const wait = peek(key, perMinute, at);
        // A refused request spends nothing, so it never eats into another bucket.
        if (wait > 0) return { ok: false, retryAfterSeconds: wait, scope };
      }
      for (const { key } of checks) buckets.get(key)!.tokens -= 1;
      return { ok: true };
    },
    size: () => buckets.size,
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;

function positiveInteger(source: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = source[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive whole number, got "${raw}"`);
  }
  return value;
}

export function loadRateLimitConfig(source: NodeJS.ProcessEnv): RateLimitConfig {
  const flag = source.RATE_LIMIT_ENABLED;
  let enabled: boolean;
  if (flag === undefined || flag === "") enabled = source.NODE_ENV === "production";
  else if (flag === "1" || flag === "true") enabled = true;
  else if (flag === "0" || flag === "false") enabled = false;
  else throw new Error(`RATE_LIMIT_ENABLED must be 1 or 0, got "${flag}"`);
  return {
    enabled,
    userPerMinute: positiveInteger(source, "RATE_LIMIT_USER_PER_MINUTE", 600),
    anonPerMinute: positiveInteger(source, "RATE_LIMIT_ANON_PER_MINUTE", 120),
    anonGlobalPerMinute: positiveInteger(source, "RATE_LIMIT_ANON_GLOBAL_PER_MINUTE", 1200),
    expensivePerMinute: positiveInteger(source, "RATE_LIMIT_EXPENSIVE_PER_MINUTE", 30),
    webhookPerMinute: positiveInteger(source, "RATE_LIMIT_WEBHOOK_PER_MINUTE", 600),
    webhookGlobalPerMinute: positiveInteger(source, "RATE_LIMIT_WEBHOOK_GLOBAL_PER_MINUTE", 3000),
  };
}

/**
 * Limits /rpc, /api/v1 and /api/voice. `userIdFor` resolves the session; pass the same memoized
 * lookup the routes use, so a request still costs one session query.
 */
export function mountRateLimits(
  app: Hono,
  limiter: RateLimiter,
  userIdFor: (request: Request) => Promise<string | null>,
): void {
  const handler = async (
    c: Parameters<Parameters<Hono["use"]>[1]>[0],
    next: () => Promise<void>,
  ) => {
    const path = new URL(c.req.url).pathname;
    // Webhooks carry no session; looking one up would cost a query per flood request.
    const userId = rateLimitClass(path) === "webhook" ? null : await userIdFor(c.req.raw);
    const decision = limiter.check({ userId, address: clientAddress(c.req.raw.headers), path });
    if (decision.ok) return next();
    const errorId = randomUUID();
    getLogger().warn("rate limited", {
      "user.id": userId ?? "anonymous",
      "http.path": path,
      "rate_limit.scope": decision.scope,
      "error.id": errorId,
    });
    c.header("retry-after", String(decision.retryAfterSeconds));
    return c.json({ error: "Too many requests", error_id: errorId }, 429);
  };
  app.use("/rpc/*", handler);
  app.use("/api/v1/*", handler);
  app.use("/api/voice/*", handler);
}
