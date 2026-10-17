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
    create: (password) => createTestAccount(prisma, { password, policyEnv }),
    list: () => listTestAccounts(prisma),
    remove: (email) =>
      deleteTestAccount(prisma, {
        email,
        webOrigin: env.webOrigin,
        request: (path, init) => fetch(new URL(path, apiUrl), init),
      }),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
} finally {
  await prisma.$disconnect();
  await pool.end();
}
