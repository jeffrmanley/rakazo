import { randomUUID } from "node:crypto";
import type { TwoFactorEvent } from "@rakazo/auth";
import type { AuditActor, AuditEventKind, PrismaClient } from "@rakazo/db";
import { getAuditWriter } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

const AUDIT_KIND: Record<TwoFactorEvent["kind"], AuditEventKind> = {
  enabled: "auth.2fa_enabled",
  disabled: "auth.2fa_disabled",
  failed: "auth.2fa_failed",
};

const SUMMARY: Record<TwoFactorEvent["kind"], string> = {
  enabled: "Two-factor sign-in turned on",
  disabled: "Two-factor sign-in turned off",
  failed: "Two-factor code refused",
};

/**
 * Logs a two-factor event and, with EXT_AUDIT_LOG, appends it to the account's default space.
 * Events carry the user id, the client address, the refusal reason and an error id; the code
 * that was entered never reaches here. A failed audit write raises, like every audited path.
 */
export async function recordTwoFactorEvent(
  prisma: Pick<PrismaClient, "spaceMember">,
  event: TwoFactorEvent,
  actor?: AuditActor,
): Promise<void> {
  const errorId = event.kind === "failed" ? randomUUID() : undefined;
  const fields = {
    "user.id": event.userId ?? "unknown",
    "client.address": event.ip ?? "unknown",
    ...(event.kind === "failed" ? { "error.id": errorId, reason: event.reason } : {}),
  };
  if (event.kind === "failed") getLogger().warn("two-factor verification failed", fields);
  else getLogger().info(`two-factor ${event.kind}`, fields);

  const writer = getAuditWriter();
  if (!writer || !event.userId) return;
  const membership = await prisma.spaceMember.findFirst({
    where: { userId: event.userId },
    orderBy: [{ space: { isDefault: "desc" } }, { createdAt: "asc" }, { id: "asc" }],
    select: { spaceId: true },
  });
  // An account without a space has no chain to append to; the log line above still stands.
  if (!membership) return;
  await writer.record({
    spaceId: membership.spaceId,
    actor: actor ?? { type: "human", id: event.userId },
    kind: AUDIT_KIND[event.kind],
    summary: SUMMARY[event.kind],
    detail: {
      userId: event.userId,
      ip: event.ip,
      ...(event.kind === "failed" ? { reason: event.reason, errorId } : {}),
    },
  });
}
