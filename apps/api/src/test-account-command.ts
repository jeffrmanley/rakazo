import type { TestAccountResult } from "@rakazo/auth";

/** The `test-account` operator command (docs/test-accounts.md), with its effects injected. */
export interface TestAccountCommandDeps {
  readStdin: () => Promise<string>;
  create: (password: string) => Promise<TestAccountResult<{ email: string; spaceId: string }>>;
  list: () => Promise<Array<{ email: string; createdAt: Date }>>;
  remove: (email: string) => Promise<TestAccountResult<"deleted" | "absent">>;
  now: () => Date;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const USAGE = "usage: test-account create (password on stdin) | list | delete <email>|--all";
/** A test account older than this is a leftover from a run that never cleaned up. */
export const TEST_ACCOUNT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** `list` returns at most 100 accounts, so `--all` repeats; this bounds the repeats. */
const MAX_DELETE_ROUNDS = 20;

export async function runTestAccountCommand(
  args: string[],
  deps: TestAccountCommandDeps,
): Promise<number> {
  const [command, target, ...rest] = args;
  if (command === "create" && target === undefined) {
    const password = (await deps.readStdin()).replace(/\r?\n$/, "");
    const cutoff = deps.now().getTime() - TEST_ACCOUNT_MAX_AGE_MS;
    const expired = (await deps.list()).filter((account) => account.createdAt.getTime() < cutoff);
    // Notes go to stderr: stdout carries only the JSON line.
    if ((await removeAll(expired, deps, "expired", deps.stderr)) > 0) return 1;
    const created = await deps.create(password);
    if (!created.ok) {
      deps.stderr(`refused: ${created.reason}`);
      return 2;
    }
    deps.stdout(JSON.stringify({ email: created.value.email, spaceId: created.value.spaceId }));
    return 0;
  }
  if (command === "list" && target === undefined) {
    for (const account of await deps.list()) {
      deps.stdout(`${account.email} ${account.createdAt.toISOString()}`);
    }
    return 0;
  }
  if (command === "delete" && target === "--all" && rest.length === 0) {
    for (let round = 0; round < MAX_DELETE_ROUNDS; round += 1) {
      const accounts = await deps.list();
      if (accounts.length === 0) return 0;
      if ((await removeAll(accounts, deps, "deleted", deps.stdout)) > 0) return 1;
    }
    deps.stderr("failed: test accounts remain after repeated deletion");
    return 1;
  }
  if (command === "delete" && target !== undefined && rest.length === 0) {
    const removed = await deps.remove(target);
    if (removed.ok) {
      deps.stdout(`${removed.value}: ${target}`);
      return 0;
    }
    if (removed.reason === "not a test account address") {
      deps.stderr(`refused: ${target}: ${removed.reason}`);
      return 2;
    }
    deps.stderr(`failed: ${target}: ${removed.reason}`);
    return 1;
  }
  deps.stderr(USAGE);
  return 2;
}

/** Removes each account, reporting as it goes; returns how many failed. */
async function removeAll(
  accounts: Array<{ email: string }>,
  deps: Pick<TestAccountCommandDeps, "remove" | "stderr">,
  label: string,
  report: (line: string) => void,
): Promise<number> {
  let failed = 0;
  for (const { email } of accounts) {
    const removed = await deps.remove(email);
    if (removed.ok) {
      report(`${removed.value === "absent" ? "absent" : label}: ${email}`);
    } else {
      deps.stderr(`failed: ${email}: ${removed.reason}`);
      failed += 1;
    }
  }
  return failed;
}
