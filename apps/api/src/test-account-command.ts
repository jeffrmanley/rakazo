import type { TestAccountResult } from "@rakazo/auth";

/** The `test-account` operator command (docs/test-accounts.md), with its effects injected. */
export interface TestAccountCommandDeps {
  readStdin: () => Promise<string>;
  create: (password: string) => Promise<TestAccountResult<{ email: string; spaceId: string }>>;
  list: () => Promise<Array<{ email: string; createdAt: Date }>>;
  remove: (email: string) => Promise<TestAccountResult<"deleted" | "absent">>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const USAGE = "usage: test-account create (password on stdin) | list | delete <email>|--all";

export async function runTestAccountCommand(
  args: string[],
  deps: TestAccountCommandDeps,
): Promise<number> {
  const [command, target, ...rest] = args;
  if (command === "create" && target === undefined) {
    const password = (await deps.readStdin()).replace(/\r?\n$/, "");
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
  if (command === "delete" && target !== undefined && rest.length === 0) {
    const emails =
      target === "--all" ? (await deps.list()).map((account) => account.email) : [target];
    let failed = 0;
    for (const email of emails) {
      const removed = await deps.remove(email);
      if (removed.ok) {
        deps.stdout(`${removed.value}: ${email}`);
        continue;
      }
      if (removed.reason === "not a test account address") {
        deps.stderr(`refused: ${email}: ${removed.reason}`);
        return 2;
      }
      deps.stderr(`failed: ${email}: ${removed.reason}`);
      failed += 1;
    }
    return failed > 0 ? 1 : 0;
  }
  deps.stderr(USAGE);
  return 2;
}
