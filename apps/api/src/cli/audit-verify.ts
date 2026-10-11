import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { createDb, listAuditChainSpaces, verifyAuditChain } from "@rakazo/db";
import { formatAuditVerification } from "../ext-audit.js";

loadRootEnv();

/**
 * Recompute every space's audit chain (or the spaces given with --space) and
 * report the first break. Exit code 1 when any chain is broken.
 */
const args = process.argv.slice(2);
const requested: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--space" && args[index + 1]) {
    requested.push(args[index + 1]!);
    index += 1;
    continue;
  }
  throw new Error("Usage: audit:verify [--space <spaceId>]...");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const { prisma, pool } = createDb(process.env.DATABASE_URL, {
  applicationName: "rakazo-audit-verify",
});
let broken = 0;
try {
  const spaces = requested.length > 0 ? requested : await listAuditChainSpaces(prisma);
  if (spaces.length === 0) process.stdout.write("no audit chains found\n");
  for (const spaceId of spaces) {
    const result = await verifyAuditChain(prisma, { spaceId });
    if (!result.ok) broken += 1;
    process.stdout.write(`${formatAuditVerification(result)}\n`);
  }
} finally {
  await prisma.$disconnect();
  await pool.end();
}
process.exitCode = broken > 0 ? 1 : 0;
