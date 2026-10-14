/**
 * Fork extension configuration. Every name carries the EXT_ prefix so nothing
 * here can collide with an upstream variable, and every module is off until
 * its flag is exactly "1" (default deny: missing configuration means off).
 */
export interface ExtEnv {
  /** Tamper-evident audit log (ext_audit_events) and its API. */
  auditLog: boolean;
  /** Emergency stop/resume controls. Parsed here; enforced by a later module. */
  emergencyStop: boolean;
  /** Spend, concurrency and delegation caps (docs/governance/budgets.md). */
  budgets: boolean;
  budgetDefaultDailyUsd: number;
  budgetSpaceDailyUsd: number;
  maxConcurrentRunsPerBot: number;
  maxSpawnDepth: number;
  maxSpawnFanout: number;
  /** Optional off-box copy of sealed audit segments. */
  auditExportDir: string | undefined;
}

export const EXT_FLAG_NAMES = ["EXT_AUDIT_LOG", "EXT_EMERGENCY_STOP", "EXT_BUDGETS"] as const;

export function loadExtEnv(source: NodeJS.ProcessEnv = process.env): ExtEnv {
  return {
    auditLog: flag(source, "EXT_AUDIT_LOG"),
    emergencyStop: flag(source, "EXT_EMERGENCY_STOP"),
    budgets: flag(source, "EXT_BUDGETS"),
    budgetDefaultDailyUsd: amount(source, "EXT_BUDGET_DEFAULT_DAILY_USD", 3),
    budgetSpaceDailyUsd: amount(source, "EXT_BUDGET_SPACE_DAILY_USD", 50),
    maxConcurrentRunsPerBot: count(source, "EXT_MAX_CONCURRENT_RUNS_PER_BOT", 2),
    maxSpawnDepth: count(source, "EXT_MAX_SPAWN_DEPTH", 2),
    maxSpawnFanout: count(source, "EXT_MAX_SPAWN_FANOUT", 5),
    auditExportDir: optional(source.EXT_AUDIT_EXPORT_DIR),
  };
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function flag(source: NodeJS.ProcessEnv, name: (typeof EXT_FLAG_NAMES)[number]): boolean {
  const value = optional(source[name]);
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error(`${name} must be 0 or 1`);
}

function amount(source: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = optional(source[name]);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function count(source: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = optional(source[name]);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}
