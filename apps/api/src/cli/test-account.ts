import { randomUUID } from "node:crypto";
import { text } from "node:stream/consumers";
import { createTestAccount, deleteTestAccount, listTestAccounts } from "@rakazo/auth";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { createDb } from "@rakazo/db";
import { loadEnv } from "../env.js";
import { runTestAccountCommand } from "../test-account-command.js";

loadRootEnv();

/**
 * Throwaway accounts for live acceptance checks (docs/test-accounts.md). Run inside the api
 * container; `delete` goes through the API listening there.
 */
const env = loadEnv(process.env);
const apiUrl = `http://127.0.0.1:${env.port}`;
const { prisma, pool } = createDb(env.databaseUrl, { applicationName: "rakazo-test-account" });
const policyEnv = { signupsEnabled: env.signupsEnabled, signupAllowlist: env.signupAllowlist };
try {
  process.exitCode = await runTestAccountCommand(process.argv.slice(2), {
    readStdin: () => text(process.stdin),
    create: (password) =>
      createTestAccount(prisma, { password, policyEnv, passwordAuth: env.passwordAuth !== false }),
    list: () => listTestAccounts(prisma),
    remove: (email) =>
      deleteTestAccount(prisma, {
        email,
        webOrigin: env.webOrigin,
        // A loopback client address, so these sign-ins count against their own rate-limit
        // bucket rather than the one shared by every request that carries no address.
        request: (path, init) =>
          fetch(new URL(path, apiUrl), {
            ...init,
            headers: {
              ...(init.headers as Record<string, string>),
              "x-forwarded-for": "127.0.0.1",
            },
          }),
      }),
    now: () => new Date(),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
} catch (error) {
  // Messages from the database layer can carry row values (a password hash, ids); keep them out.
  const code =
    error && typeof error === "object" && "code" in error ? ` ${String(error.code)}` : "";
  const name = error instanceof Error ? error.name : "Error";
  process.stderr.write(`failed: internal error (error_id=${randomUUID()}, ${name}${code})\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  await pool.end();
}
