import { randomUUID } from "node:crypto";
import { resetTwoFactor } from "@rakazo/auth";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { createAuditWriter, createDb, installAuditWriter } from "@rakazo/db";
import { loadEnv } from "../env.js";
import { runReset2faCommand } from "../reset-2fa-command.js";
import { recordTwoFactorEvent } from "../two-factor-events.js";

loadRootEnv();

/**
 * Removes an account's second factor when its owner has lost both the authenticator and the
 * backup codes (docs/security/two-factor.md). Host operator only: run it in the api container
 * as `pnpm exec tsx src/cli/reset-2fa.ts <email>`. No HTTP route or deploy helper reaches it,
 * so an agent session cannot strip the owner's second factor.
 */
const env = loadEnv(process.env);
const { prisma, pool } = createDb(env.databaseUrl, { applicationName: "rakazo-reset-2fa" });
installAuditWriter(env.ext.auditLog ? createAuditWriter(prisma) : null);
try {
  process.exitCode = await runReset2faCommand(process.argv.slice(2), {
    reset: (email) => resetTwoFactor(prisma, email),
    recorded: (userId) =>
      recordTwoFactorEvent(
        prisma,
        { kind: "disabled", userId, ip: null },
        { type: "system", id: "reset-2fa" },
      ),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
} catch (error) {
  // Messages from the database layer can carry row values (a secret, ids); keep them out.
  const code =
    error && typeof error === "object" && "code" in error ? ` ${String(error.code)}` : "";
  const name = error instanceof Error ? error.name : "Error";
  process.stderr.write(`failed: internal error (error_id=${randomUUID()}, ${name}${code})\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  await pool.end();
}
