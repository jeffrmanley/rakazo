import { t } from "@lingui/core/macro";
import type { BudgetLevel, BudgetProfile } from "@rakazo/core";
import { readBoundedJsonResponse } from "@rakazo/core";
import { extModuleEnabled } from "./ext-modules";
import { withSpaceHeaders } from "./rpc";

/** Spend against one cap today (UTC day). */
export type CapView = {
  spentUsd: number;
  capUsd: number;
  topUpUsd: number;
  level: BudgetLevel;
};

export type BotBudgetView = {
  day: string;
  bot: CapView & { profile: BudgetProfile; customDailyUsd: number | null };
  space: CapView;
  settings: {
    profile: BudgetProfile;
    customDailyUsd: number | null;
    premium: boolean;
    maxConcurrentRuns: number | null;
    maxSpawnDepth: number | null;
    maxSpawnFanout: number | null;
  };
  defaults: {
    assistantDailyUsd: number;
    maxConcurrentRuns: number;
    maxSpawnDepth: number;
    maxSpawnFanout: number;
  };
  /** Space owners may raise budgets; a bot owner may only lower them below the defaults. */
  canRaise: boolean;
  canSetPremium: boolean;
  canTopUp: boolean;
};

export type SpaceBudgetView = CapView & {
  day: string;
  baseUsd: number;
  custom: boolean;
  canManage?: boolean;
};

export type BotBudgetPatch = Partial<BotBudgetView["settings"]>;

const BASE = "/api/v1/budgets";

/**
 * Budgets are an optional server module. Reads skip it when the server says it is off;
 * a 404 means the same (or the bot is not reachable), and the caller shows nothing:
 * null, never an error.
 */
async function budgetRequest<T>(path: string, init?: { method: string; body: unknown }) {
  if (!init && !(await extModuleEnabled("budgets"))) return null;
  const response = await fetch(`${BASE}${path}`, {
    method: init?.method ?? "GET",
    credentials: "include",
    headers: withSpaceHeaders(init ? { "content-type": "application/json" } : undefined),
    body: init ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return null;
  let body: unknown;
  try {
    body = await readBoundedJsonResponse<unknown>(response, 64 * 1024);
  } catch {
    // Gateways may return HTML or an empty body.
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : t`Could not save`;
    throw new Error(message);
  }
  return body as T;
}

export const fetchBotBudget = (botId: string) =>
  budgetRequest<BotBudgetView>(`/bots/${encodeURIComponent(botId)}`);

export const saveBotBudget = (botId: string, patch: BotBudgetPatch) =>
  budgetRequest<BotBudgetView>(`/bots/${encodeURIComponent(botId)}`, {
    method: "PUT",
    body: patch,
  });

export const topUpBotBudget = (botId: string, amountUsd: number) =>
  budgetRequest<unknown>(`/bots/${encodeURIComponent(botId)}/top-up`, {
    method: "POST",
    body: { amountUsd },
  });

export const fetchSpaceBudget = () => budgetRequest<SpaceBudgetView>("/space");

export const saveSpaceBudget = (dailyUsd: number | null) =>
  budgetRequest<SpaceBudgetView>("/space", { method: "PUT", body: { dailyUsd } });

export const topUpSpaceBudget = (amountUsd: number) =>
  budgetRequest<unknown>("/space/top-up", { method: "POST", body: { amountUsd } });

/** A typed dollar amount, or null when blank or not a number. */
export function parseUsdInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A typed limit; blank means "use the default" (null). */
export function parseLimitInput(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
