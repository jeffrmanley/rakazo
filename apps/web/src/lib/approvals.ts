import { t } from "@lingui/core/macro";
import type { RiskClass } from "@rakazo/core";
import { readBoundedJsonResponse } from "@rakazo/core";
import { extModuleEnabled } from "./ext-modules";
import { withSpaceHeaders } from "./rpc";

/** A bot's approval policy (EXT_APPROVALS), as a space owner sees it in bot settings. */
export type BotApprovalsView = {
  policy: { gatedClasses: RiskClass[]; approverUserIds: string[] };
  defaults: { gatedClasses: RiskClass[] };
  riskClasses: RiskClass[];
  members: Array<{ userId: string; name: string; owner: boolean }>;
};

export type BotApprovalsPatch = Partial<BotApprovalsView["policy"]>;

const BASE = "/api/v1/approvals/bots";

/**
 * Approvals are an optional server module. Reads skip it when the server says it is off; a
 * 404 means the same, or a viewer who is not a space owner, and the caller shows nothing.
 */
async function approvalsRequest(path: string, init?: { method: string; body: unknown }) {
  if (!init && !(await extModuleEnabled("approvals"))) return null;
  const response = await fetch(`${BASE}${path}`, {
    method: init?.method ?? "GET",
    credentials: "include",
    headers: withSpaceHeaders(init ? { "content-type": "application/json" } : undefined),
    body: init ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404 && !init) return null;
  let body: unknown;
  try {
    body = await readBoundedJsonResponse<unknown>(response, 64 * 1024);
  } catch {
    // Gateways may return HTML or an empty body.
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : t`Could not save`;
    throw new Error(message);
  }
  return body as BotApprovalsView;
}

export const fetchBotApprovals = (botId: string) =>
  approvalsRequest(`/${encodeURIComponent(botId)}`);

export const saveBotApprovals = (botId: string, patch: BotApprovalsPatch) =>
  approvalsRequest(`/${encodeURIComponent(botId)}`, { method: "PUT", body: patch });
