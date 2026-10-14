/**
 * Fork extension: spend caps, run concurrency and delegation limits (EXT_BUDGETS).
 * Pure rules shared by the API, the worker and the UI. Storage lives in
 * `@rakazo/db` (ext-budgets.ts); enforcement in `@rakazo/adapters` (ext-budget-guard.ts).
 */
import type { ExtEnv } from "./ext-env.js";

export const BUDGET_PROFILES = ["assistant", "worker", "swarm", "custom"] as const;
export type BudgetProfile = (typeof BUDGET_PROFILES)[number];

/** Fixed daily caps; `assistant` comes from EXT_BUDGET_DEFAULT_DAILY_USD. */
export const BUDGET_PROFILE_DAILY_USD = { worker: 15, swarm: 40 } as const;
/** Upper bound for any custom cap, space cap or single top-up. */
export const BUDGET_MAX_DAILY_USD = 10_000;
/** Upper bound for a per-bot concurrency or delegation override. */
export const BUDGET_MAX_LIMIT = 50;
export const BUDGET_WARN_RATIO = 0.8;
export const BUDGET_MONTHLY_SPACE_ALERT_USD = 400;

export const BUDGET_STOP_TEXT = "Stopped: daily budget reached.";
export const BUDGET_BLOCK_TEXT =
  "This bot reached its daily budget. A space owner can top it up in settings.";
export const BUDGET_SPACE_BLOCK_TEXT =
  "This space reached its daily budget. A space owner can top it up in settings.";

export type BudgetDefaults = Pick<
  ExtEnv,
  | "budgetDefaultDailyUsd"
  | "budgetSpaceDailyUsd"
  | "maxConcurrentRunsPerBot"
  | "maxSpawnDepth"
  | "maxSpawnFanout"
>;

export interface BotBudgetSettings {
  profile: BudgetProfile;
  customDailyUsd: number | null;
}

export interface BotLimitSettings {
  maxConcurrentRuns: number | null;
  maxSpawnDepth: number | null;
  maxSpawnFanout: number | null;
}

export interface BotLimits {
  maxConcurrentRuns: number;
  maxSpawnDepth: number;
  maxSpawnFanout: number;
}

export interface UtcPeriod {
  key: string;
  start: Date;
  end: Date;
}

/** The budget day: the UTC calendar day containing `now`, as [start, end). */
export function utcDay(now: Date): UtcPeriod {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 1);
  return { key: start.toISOString().slice(0, 10), start, end };
}

/** The UTC calendar month containing `now`, as [start, end). */
export function utcMonth(now: Date): UtcPeriod {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { key: start.toISOString().slice(0, 7), start, end };
}

export type BudgetLevel = "ok" | "warn" | "blocked";

function cents(value: number): number {
  return Math.round(value * 100);
}

/** Micro-dollars are the unit of comparison so float sums cannot flip a threshold. */
function micros(value: number): number {
  return Math.round(value * 1_000_000);
}

export function budgetLevel(spentUsd: number, capUsd: number): BudgetLevel {
  const spent = micros(spentUsd);
  const cap = micros(capUsd);
  if (spent >= cap) return "blocked";
  if (spent >= Math.round(cap * BUDGET_WARN_RATIO)) return "warn";
  return "ok";
}

/** Today's cap for a bot: its profile (or custom amount) plus today's top-ups. */
export function dailyCapUsd(
  settings: BotBudgetSettings | null,
  defaults: Pick<BudgetDefaults, "budgetDefaultDailyUsd">,
  topUpUsd = 0,
): number {
  return profileDailyUsd(settings, defaults) + topUpUsd;
}

export function profileDailyUsd(
  settings: BotBudgetSettings | null,
  defaults: Pick<BudgetDefaults, "budgetDefaultDailyUsd">,
): number {
  switch (settings?.profile) {
    case "worker":
    case "swarm":
      return BUDGET_PROFILE_DAILY_USD[settings.profile];
    case "custom":
      return settings.customDailyUsd ?? defaults.budgetDefaultDailyUsd;
    default:
      return defaults.budgetDefaultDailyUsd;
  }
}

export function isBudgetProfile(value: unknown): value is BudgetProfile {
  return typeof value === "string" && (BUDGET_PROFILES as readonly string[]).includes(value);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** A positive dollar amount, at most BUDGET_MAX_DAILY_USD, rounded to cents. */
export function parseBudgetAmount(value: unknown): Parsed<number> {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, error: "Amount must be a number" };
  }
  const rounded = cents(value) / 100;
  if (rounded <= 0) return { ok: false, error: "Amount must be at least $0.01" };
  if (rounded > BUDGET_MAX_DAILY_USD) {
    return { ok: false, error: `Amount must be at most $${BUDGET_MAX_DAILY_USD}` };
  }
  return { ok: true, value: rounded };
}

/** `null` means "use the deployment default"; otherwise an integer in [0, max]. */
export function parseLimit(value: unknown, max = BUDGET_MAX_LIMIT): Parsed<number | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    return { ok: false, error: `Limit must be a whole number from 0 to ${max}` };
  }
  return { ok: true, value };
}

export function resolveBotLimits(
  settings: BotLimitSettings | null,
  defaults: Pick<BudgetDefaults, "maxConcurrentRunsPerBot" | "maxSpawnDepth" | "maxSpawnFanout">,
): BotLimits {
  return {
    // Zero concurrency would queue a bot forever; one is the floor.
    maxConcurrentRuns: Math.max(1, settings?.maxConcurrentRuns ?? defaults.maxConcurrentRunsPerBot),
    maxSpawnDepth: settings?.maxSpawnDepth ?? defaults.maxSpawnDepth,
    maxSpawnFanout: settings?.maxSpawnFanout ?? defaults.maxSpawnFanout,
  };
}

/**
 * The most expensive model tier (Fable and Mythos class), identified by model id.
 * Only bots marked premium may use it.
 */
export function isPremiumModelId(modelId: string | null | undefined): boolean {
  return typeof modelId === "string" && /fable|mythos/i.test(modelId);
}

export const PREMIUM_MODEL_REFUSAL =
  "This model is limited to premium bots. A space owner can mark the bot premium in settings.";

export type SpawnCheck =
  | { ok: true; depth: number }
  | { ok: false; reason: "depth" | "fanout"; error: string };

/**
 * A delegation started by a run at `parentDepth` that has already started `started`
 * delegations. The refusal text is a tool error the model reads, so it says what to do.
 */
export function checkSpawnLimits(
  input: { parentDepth: number; started: number },
  limits: Pick<BotLimits, "maxSpawnDepth" | "maxSpawnFanout">,
): SpawnCheck {
  const depth = input.parentDepth + 1;
  if (depth > limits.maxSpawnDepth) {
    return {
      ok: false,
      reason: "depth",
      error: `Delegation refused: this run is already at the delegation depth limit (${limits.maxSpawnDepth}). Nothing was started. Do the work yourself or report back.`,
    };
  }
  if (input.started >= limits.maxSpawnFanout) {
    return {
      ok: false,
      reason: "fanout",
      error: `Delegation refused: this run already started ${input.started} delegations, the limit is ${limits.maxSpawnFanout}. Nothing was started. Do the work yourself or report back.`,
    };
  }
  return { ok: true, depth };
}

export type BudgetNoticeKind = "bot.warn" | "space.warn" | "space.month";

/** De-duplication key: one notice per subject per UTC day (or month for the monthly alert). */
export function budgetNoticeKey(
  kind: BudgetNoticeKind,
  subjectId: string,
  now: Date,
): { kind: BudgetNoticeKind; subjectId: string; period: string } {
  const period = kind === "space.month" ? utcMonth(now).key : utcDay(now).key;
  return { kind, subjectId, period };
}

export function formatUsd(value: number): string {
  return `$${(cents(value) / 100).toFixed(2)}`;
}
