import { describe, expect, it, vi } from "vitest";
import { runTestAccountCommand, type TestAccountCommandDeps } from "./test-account-command.js";

const EMAIL = "live-test-0123456789ab@live-test.invalid";
const PASSWORD = "a-long-enough-test-password";

function deps(overrides: Partial<TestAccountCommandDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const base: TestAccountCommandDeps = {
    readStdin: async () => `${PASSWORD}\n`,
    create: vi.fn(async () => ({
      ok: true as const,
      value: { email: EMAIL, userId: "user-1", spaceId: "space-1" },
    })),
    list: vi.fn(async () => [{ email: EMAIL, createdAt: new Date("2026-10-17T00:00:00Z") }]),
    remove: vi.fn(async () => ({ ok: true as const, value: "deleted" as const })),
    now: () => new Date("2026-10-17T12:00:00Z"),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  };
  return { deps: { ...base, ...overrides }, out, err };
}

describe("test-account command", () => {
  it.each([[[]], [["unknown"]], [["delete"]], [["create", "extra"]], [["delete", EMAIL, "x"]]])(
    "rejects usage %j with exit 2",
    async (args) => {
      const { deps: d, err } = deps();
      expect(await runTestAccountCommand(args, d)).toBe(2);
      expect(err.join("\n")).toContain("usage");
    },
  );

  it("create reads the password from stdin without the newline and never prints it", async () => {
    const { deps: d, out, err } = deps();
    expect(await runTestAccountCommand(["create"], d)).toBe(0);
    expect(d.create).toHaveBeenCalledWith(PASSWORD);
    expect(out).toEqual([JSON.stringify({ email: EMAIL, spaceId: "space-1" })]);
    expect([...out, ...err].join("\n")).not.toContain(PASSWORD);
  });

  it("create first deletes test accounts older than a day, noting them on stderr only", async () => {
    const old = "live-test-0000000000aa@live-test.invalid";
    const remove = vi.fn(async () => ({ ok: true as const, value: "deleted" as const }));
    const {
      deps: d,
      out,
      err,
    } = deps({
      list: vi.fn(async () => [
        { email: EMAIL, createdAt: new Date("2026-10-17T11:00:00Z") },
        { email: old, createdAt: new Date("2026-10-16T11:59:00Z") },
      ]),
      remove,
    });
    expect(await runTestAccountCommand(["create"], d)).toBe(0);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(old);
    expect(err).toEqual([`expired: ${old}`]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual({ email: EMAIL, spaceId: "space-1" });
  });

  it("create stops before creating when an expired account cannot be deleted", async () => {
    const { deps: d, out } = deps({
      list: vi.fn(async () => [{ email: EMAIL, createdAt: new Date("2026-10-01T00:00:00Z") }]),
      remove: vi.fn(async () => ({ ok: false as const, reason: "sign-in failed with 500" })),
    });
    expect(await runTestAccountCommand(["create"], d)).toBe(1);
    expect(d.create).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it("create reports a refused password with exit 2", async () => {
    const { deps: d, err } = deps({
      readStdin: async () => "short\n",
      create: vi.fn(async () => ({ ok: false as const, reason: "needs at least 16" })),
    });
    expect(await runTestAccountCommand(["create"], d)).toBe(2);
    expect(err.join("\n")).toContain("needs at least 16");
  });

  it("list prints one line per account", async () => {
    const { deps: d, out } = deps();
    expect(await runTestAccountCommand(["list"], d)).toBe(0);
    expect(out).toEqual([`${EMAIL} 2026-10-17T00:00:00.000Z`]);
  });

  it("delete refuses a real address with exit 2", async () => {
    const { deps: d, err } = deps({
      remove: vi.fn(async () => ({ ok: false as const, reason: "not a test account address" })),
    });
    expect(await runTestAccountCommand(["delete", "owner@example.com"], d)).toBe(2);
    expect(err.join("\n")).toContain("not a test account");
  });

  it("delete reports a failed deletion with exit 1", async () => {
    const { deps: d, err } = deps({
      remove: vi.fn(async () => ({ ok: false as const, reason: "sign-in failed with 429" })),
    });
    expect(await runTestAccountCommand(["delete", EMAIL], d)).toBe(1);
    expect(err.join("\n")).toContain("429");
  });

  it("delete --all repeats until the list is empty", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([{ email: EMAIL, createdAt: new Date() }])
      .mockResolvedValueOnce([{ email: EMAIL, createdAt: new Date() }])
      .mockResolvedValueOnce([]);
    const { deps: d, out } = deps({ list });
    expect(await runTestAccountCommand(["delete", "--all"], d)).toBe(0);
    expect(list).toHaveBeenCalledTimes(3);
    expect(out).toEqual([`deleted: ${EMAIL}`, `deleted: ${EMAIL}`]);
  });

  it("delete --all gives up when accounts keep coming back", async () => {
    const { deps: d, err } = deps();
    expect(await runTestAccountCommand(["delete", "--all"], d)).toBe(1);
    expect(err.join("\n")).toContain("remain");
  });

  it("delete --all removes every listed account and keeps going after a failure", async () => {
    const second = "live-test-ba9876543210@live-test.invalid";
    const remove = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "delete-user failed with 500" })
      .mockResolvedValueOnce({ ok: true, value: "deleted" });
    const {
      deps: d,
      out,
      err,
    } = deps({
      list: vi.fn(async () => [
        { email: EMAIL, createdAt: new Date() },
        { email: second, createdAt: new Date() },
      ]),
      remove,
    });
    expect(await runTestAccountCommand(["delete", "--all"], d)).toBe(1);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(out).toEqual([`deleted: ${second}`]);
    expect(err.join("\n")).toContain(`${EMAIL}: delete-user failed with 500`);
  });
});
