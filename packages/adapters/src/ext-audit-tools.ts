import type { AgentToolExecutionObserver, ConnectorRoute } from "@rakazo/adapter-kit";
import type { AuditWriter } from "@rakazo/db";
import { AuditWriteError } from "@rakazo/db";
import { isToolPauseResult } from "./approval-effect.js";
import { sanitizeConnectorError } from "./connector-safety.js";

export type ToolExecute = (
  name: string,
  args: Record<string, unknown>,
  executionId: string,
  route?: ConnectorRoute,
  observer?: AgentToolExecutionObserver,
) => Promise<unknown>;

export interface AuditedToolOptions {
  /** Installed writer; null leaves the tool untouched (EXT_AUDIT_LOG off). */
  audit: AuditWriter | null;
  target: { spaceId: string; botId: string; runId: string };
  /** Secret values known to the run so far; read at call time because the list grows. */
  secrets: () => string[];
  execute: ToolExecute;
  /** Called before the audit failure is rethrown, so the run can halt instead of continuing. */
  onAuditFailure?: (error: AuditWriteError) => void;
}

/**
 * Fail-closed tool auditing: `tool.call` is recorded before the tool runs
 * (a failed record means the tool does not run), and `tool.result` before
 * the result reaches the model (a failed record withholds the result).
 * The call's arguments are stored redacted; result bodies are never stored.
 */
export function auditedToolExecution(options: AuditedToolOptions): ToolExecute {
  const { audit, target, execute } = options;
  if (!audit) return execute;
  const actor = { type: "bot" as const, id: target.botId };
  const record = async (input: Parameters<AuditWriter["record"]>[0]) => {
    try {
      await audit.record(input);
    } catch (error) {
      const failure = AuditWriteError.from(error);
      options.onAuditFailure?.(failure);
      throw failure;
    }
  };
  return async (name, args, executionId, route, observer) => {
    await record({
      ...target,
      actor,
      kind: "tool.call",
      summary: `Tool ${name} called`,
      detail: { name, executionId, args },
      secrets: options.secrets(),
    });
    const startedAt = Date.now();
    let result: unknown;
    try {
      result = await execute(name, args, executionId, route, observer);
    } catch (error) {
      await record({
        ...target,
        actor,
        kind: "tool.result",
        summary: `Tool ${name} failed`,
        detail: {
          ...toolResultAuditDetail(name, executionId, Date.now() - startedAt, undefined),
          outcome: "error",
          error: sanitizeConnectorError(error, options.secrets()),
        },
        secrets: options.secrets(),
      });
      throw error;
    }
    const detail = toolResultAuditDetail(name, executionId, Date.now() - startedAt, result);
    await record({
      ...target,
      actor,
      kind: "tool.result",
      summary: `Tool ${name} ${detail.outcome === "succeeded" ? "succeeded" : detail.outcome === "paused" ? "paused" : "failed"}`,
      detail,
      secrets: options.secrets(),
    });
    return result;
  };
}

export interface ToolResultAuditDetail {
  name: string;
  executionId: string;
  durationMs: number;
  outcome: "succeeded" | "error" | "paused";
  error?: string;
  contentTypes?: string[];
  resultType?: string;
  resultKeys?: string[];
  resultChars?: number;
  resultItems?: number;
}

/** Shape and outcome of a tool result, without its contents. */
export function toolResultAuditDetail(
  name: string,
  executionId: string,
  durationMs: number,
  result: unknown,
): ToolResultAuditDetail {
  const detail: ToolResultAuditDetail = {
    name,
    executionId,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    outcome: "succeeded",
  };
  if (result === undefined || result === null) return detail;
  if (isToolPauseResult(result)) {
    detail.outcome = "paused";
    return detail;
  }
  if (typeof result === "string") {
    detail.resultType = "string";
    detail.resultChars = result.length;
    return detail;
  }
  if (Array.isArray(result)) {
    detail.resultType = "array";
    detail.resultItems = result.length;
    return detail;
  }
  if (typeof result !== "object") {
    detail.resultType = typeof result;
    return detail;
  }
  const record = result as Record<string, unknown>;
  if (record.kind === "agent_tool_result" && Array.isArray(record.content)) {
    detail.contentTypes = record.content.flatMap((part) => {
      const type = (part as { type?: unknown } | null)?.type;
      return typeof type === "string" ? [type] : [];
    });
    const error = errorOfToolResult(record.details);
    if (error !== undefined) {
      detail.outcome = "error";
      detail.error = sanitizeConnectorError(error);
    }
    return detail;
  }
  const error = errorOfToolResult(record);
  if (error !== undefined) {
    detail.outcome = "error";
    detail.error = sanitizeConnectorError(error);
    return detail;
  }
  detail.resultKeys = Object.keys(record).slice(0, 50);
  return detail;
}

/** Tools report failure as `error` or MCP `isError: true` instead of throwing. */
function errorOfToolResult(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as { error?: unknown; isError?: unknown; content?: unknown };
  if (record.error !== undefined && record.error !== null) {
    const message = (record.error as { message?: unknown })?.message;
    return typeof message === "string" ? message : record.error;
  }
  if (record.isError !== true) return undefined;
  const text = Array.isArray(record.content)
    ? record.content
        .map((part) => (part as { text?: unknown } | null)?.text)
        .filter((value): value is string => typeof value === "string")
        .join("\n")
        .trim()
    : "";
  return text || "tool reported an error result";
}
