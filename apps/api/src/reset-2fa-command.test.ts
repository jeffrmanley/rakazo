import { describe, expect, it, vi } from "vitest";
import type { Reset2faCommandDeps } from "./reset-2fa-command.js";
import { runReset2faCommand } from "./reset-2fa-command.js";

const EMAIL = "owner@example.com";

function deps(overrides: Partial<Reset2faCommandDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const base: Reset2faCommandDeps = {
    reset: vi.fn(async () => ({
      ok: true as const,
      value: { userId: "user-1", status: "reset" as const },
    })),
    recorded: vi.fn(async () => undefined),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
  return { deps: { ...base, ...overrides }, out, err };
}

describe("reset-2fa command", () => {
  it.each([[[]], [["a@b.c", "extra"]], [["not-an-email"]], [["--all"]]])(
    "rejects usage %j with exit 2 and touches nothing",
    async (args) => {
      const { deps: d, err } = deps();
      expect(await runReset2faCommand(args, d)).toBe(2);
      expect(err.join("\n")).toContain("usage");
      expect(d.reset).not.toHaveBeenCalled();
    },
  );

  it("resets the account and records the removal", async () => {
    const { deps: d, out } = deps();
    expect(await runReset2faCommand([EMAIL], d)).toBe(0);
    expect(d.reset).toHaveBeenCalledWith(EMAIL);
    expect(d.recorded).toHaveBeenCalledWith("user-1");
    expect(out).toEqual([`reset: ${EMAIL}`]);
  });

  it("says so, without an audit event, when the account had no second factor", async () => {
    const { deps: d, out } = deps({
      reset: vi.fn(async () => ({
        ok: true as const,
        value: { userId: "user-1", status: "not-enrolled" as const },
      })),
    });
    expect(await runReset2faCommand([EMAIL], d)).toBe(0);
    expect(d.recorded).not.toHaveBeenCalled();
    expect(out).toEqual([`not enrolled: ${EMAIL}`]);
  });

  it("fails with exit 1 for an unknown account", async () => {
    const { deps: d, err } = deps({
      reset: vi.fn(async () => ({ ok: false as const, reason: "no account has that email" })),
    });
    expect(await runReset2faCommand([EMAIL], d)).toBe(1);
    expect(err).toEqual([`failed: ${EMAIL}: no account has that email`]);
    expect(d.recorded).not.toHaveBeenCalled();
  });
});

describe("reset-2fa reachability", () => {
  it("is not wired into any deploy, update or compose script, nor an api package script", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const root = path.resolve(import.meta.dirname, "../../..");
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) files.push(full);
      }
    };
    await walk(path.join(root, "infra"));
    await walk(path.join(root, "scripts"));
    files.push(path.join(root, "apps/api/package.json"), path.join(root, "package.json"));
    for (const file of files) {
      expect(await readFile(file, "utf8"), file).not.toMatch(/reset-2fa/);
    }
  });
});
