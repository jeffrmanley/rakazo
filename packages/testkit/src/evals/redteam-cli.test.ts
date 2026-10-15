import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { REDTEAM_CASES, REDTEAM_LIVE_PROMPTS } from "./redteam-cases.js";

const cli = path.resolve(import.meta.dirname, "../cli/redteam.ts");

it("lists the red-team cases without importing a generated database client or adapters", () => {
  const guard = `
    import { registerHooks } from 'node:module';
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === '@rakazo/db' || specifier === '@rakazo/adapters') {
          throw new Error('Runtime imported before database generation');
        }
        return nextResolve(specifier, context);
      }
    });
  `;
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      `data:text/javascript,${encodeURIComponent(guard)}`,
      cli,
      "--list",
    ],
    { encoding: "utf8", timeout: 20_000 },
  );
  expect(output.trim().split("\n")).toHaveLength(
    REDTEAM_CASES.length + REDTEAM_LIVE_PROMPTS.length,
  );
  expect(output).toContain("injection-slack:");
});

it("refuses a live run unless EXT_EVALS=1, before starting anything", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "redteam-cli-"));
  const env = { ...process.env, NODE_ENV: "test" };
  delete env.EXT_EVALS;
  try {
    let stderr = "";
    try {
      execFileSync(process.execPath, ["--import", "tsx", cli, "--live", "--output", dir], {
        encoding: "utf8",
        stdio: "pipe",
        timeout: 20_000,
        env,
      });
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr);
    }
    expect(stderr).toContain("set EXT_EVALS=1 to allow them");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
