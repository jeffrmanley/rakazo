import { describe, expect, it } from "vitest";
import { EXT_FLAG_NAMES, loadExtEnv } from "./ext-env.js";

describe("loadExtEnv", () => {
  it("keeps every fork extension off and uses the spec defaults when nothing is set", () => {
    expect(loadExtEnv({})).toEqual({
      auditLog: false,
      emergencyStop: false,
      budgets: false,
      approvals: false,
      budgetDefaultDailyUsd: 3,
      budgetSpaceDailyUsd: 50,
      maxConcurrentRunsPerBot: 2,
      maxSpawnDepth: 2,
      maxSpawnFanout: 5,
      auditExportDir: undefined,
    });
  });

  it("treats a blank flag like an unset one", () => {
    expect(loadExtEnv({ EXT_AUDIT_LOG: "", EXT_BUDGETS: "  " })).toMatchObject({
      auditLog: false,
      budgets: false,
    });
  });

  it("turns a module on only for the exact value 1", () => {
    expect(loadExtEnv({ EXT_AUDIT_LOG: "1" }).auditLog).toBe(true);
    expect(loadExtEnv({ EXT_AUDIT_LOG: " 1 " }).auditLog).toBe(true);
    expect(loadExtEnv({ EXT_AUDIT_LOG: "0" }).auditLog).toBe(false);
    expect(loadExtEnv({ EXT_EMERGENCY_STOP: "1" }).emergencyStop).toBe(true);
    expect(loadExtEnv({ EXT_BUDGETS: "1" }).budgets).toBe(true);
    expect(loadExtEnv({ EXT_APPROVALS: "1" }).approvals).toBe(true);
    expect(loadExtEnv({ EXT_APPROVALS: "0" }).approvals).toBe(false);
  });

  it("fails startup on an unknown flag value instead of guessing", () => {
    for (const value of ["true", "yes", "on", "2", "enabled"]) {
      expect(() => loadExtEnv({ EXT_AUDIT_LOG: value })).toThrow("EXT_AUDIT_LOG must be 0 or 1");
    }
    expect(() => loadExtEnv({ EXT_BUDGETS: "false" })).toThrow("EXT_BUDGETS must be 0 or 1");
    expect(() => loadExtEnv({ EXT_APPROVALS: "on" })).toThrow("EXT_APPROVALS must be 0 or 1");
  });

  it("names every module flag with the EXT_ prefix so upstream variables never collide", () => {
    expect(EXT_FLAG_NAMES).toEqual([
      "EXT_AUDIT_LOG",
      "EXT_EMERGENCY_STOP",
      "EXT_BUDGETS",
      "EXT_APPROVALS",
    ]);
    for (const name of EXT_FLAG_NAMES) expect(name.startsWith("EXT_")).toBe(true);
  });

  it("parses budget and concurrency limits as non-negative numbers", () => {
    expect(
      loadExtEnv({
        EXT_BUDGET_DEFAULT_DAILY_USD: "7.5",
        EXT_BUDGET_SPACE_DAILY_USD: "120",
        EXT_MAX_CONCURRENT_RUNS_PER_BOT: "4",
        EXT_MAX_SPAWN_DEPTH: "0",
        EXT_MAX_SPAWN_FANOUT: "10",
      }),
    ).toMatchObject({
      budgetDefaultDailyUsd: 7.5,
      budgetSpaceDailyUsd: 120,
      maxConcurrentRunsPerBot: 4,
      maxSpawnDepth: 0,
      maxSpawnFanout: 10,
    });
  });

  it("rejects limits that are not numbers, negative, or fractional where a count is required", () => {
    expect(() => loadExtEnv({ EXT_BUDGET_DEFAULT_DAILY_USD: "lots" })).toThrow(
      "EXT_BUDGET_DEFAULT_DAILY_USD must be a non-negative number",
    );
    expect(() => loadExtEnv({ EXT_BUDGET_SPACE_DAILY_USD: "-1" })).toThrow(
      "EXT_BUDGET_SPACE_DAILY_USD must be a non-negative number",
    );
    expect(() => loadExtEnv({ EXT_MAX_CONCURRENT_RUNS_PER_BOT: "1.5" })).toThrow(
      "EXT_MAX_CONCURRENT_RUNS_PER_BOT must be a non-negative integer",
    );
    expect(() => loadExtEnv({ EXT_MAX_SPAWN_DEPTH: "-2" })).toThrow(
      "EXT_MAX_SPAWN_DEPTH must be a non-negative integer",
    );
    expect(() => loadExtEnv({ EXT_MAX_SPAWN_FANOUT: "" })).not.toThrow();
  });

  it("keeps the export directory optional and trimmed", () => {
    expect(loadExtEnv({}).auditExportDir).toBeUndefined();
    expect(loadExtEnv({ EXT_AUDIT_EXPORT_DIR: "   " }).auditExportDir).toBeUndefined();
    expect(loadExtEnv({ EXT_AUDIT_EXPORT_DIR: " /var/audit " }).auditExportDir).toBe("/var/audit");
  });
});
