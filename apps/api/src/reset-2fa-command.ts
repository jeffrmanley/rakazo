/** The `reset-2fa` host-operator command (docs/security/two-factor.md), with its effects injected. */
export interface Reset2faCommandDeps {
  reset: (
    email: string,
  ) => Promise<
    | { ok: true; value: { userId: string; status: "reset" | "not-enrolled" } }
    | { ok: false; reason: string }
  >;
  /** Logs and, with EXT_AUDIT_LOG, audits the removal. */
  recorded: (userId: string) => Promise<void>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const USAGE = "usage: reset-2fa <email>";

export async function runReset2faCommand(
  args: string[],
  deps: Reset2faCommandDeps,
): Promise<number> {
  const [email, ...rest] = args;
  if (!email || rest.length > 0 || !/^[^@\s]+@[^@\s]+$/.test(email)) {
    deps.stderr(USAGE);
    return 2;
  }
  const result = await deps.reset(email);
  if (!result.ok) {
    deps.stderr(`failed: ${email}: ${result.reason}`);
    return 1;
  }
  if (result.value.status === "not-enrolled") {
    deps.stdout(`not enrolled: ${email}`);
    return 0;
  }
  await deps.recorded(result.value.userId);
  deps.stdout(`reset: ${email}`);
  return 0;
}
