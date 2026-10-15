import { describe, expect, it } from "vitest";
import {
  APPROVAL_TTL_MS,
  activeApprovers,
  approvalExpiresAt,
  approvalRequired,
  approverStanding,
  DEFAULT_GATED_CLASSES,
  EXPLICIT_RISK_CLASSES,
  isApprovalExpired,
  parseApprovalPolicyPatch,
  RISK_CLASSES,
  resolveApprovalPolicy,
  resolveApprovers,
  toolRiskClass,
} from "./ext-approvals.js";

describe("toolRiskClass", () => {
  it("classes read-only built-in tools as read", () => {
    for (const toolName of [
      "read_file",
      "web_search",
      "web_fetch",
      "list_files",
      "recall_memory",
    ]) {
      expect(toolRiskClass({ toolName, viaConnector: false })).toBe("read");
    }
  });

  it("classes side effects inside the bot's own computer, memory and space as write-internal", () => {
    for (const toolName of [
      "write_file",
      "shell",
      "computer_act",
      "browser_act",
      "remember",
      "schedule_create",
      "spawn_bot",
      "archive_bot",
      "forget_secret",
    ]) {
      expect(toolRiskClass({ toolName, viaConnector: false })).toBe("write-internal");
    }
  });

  it("classes the upstream consequential tools that leave the deployment as write-external", () => {
    for (const toolName of ["destination.write", "cloud_agent_launch", "cloud_agent_reply"]) {
      expect(toolRiskClass({ toolName, viaConnector: false })).toBe("write-external");
    }
  });

  it("maps connector tools from the existing consequential classification", () => {
    expect(toolRiskClass({ toolName: "gmail_list_messages", viaConnector: true })).toBe("read");
    expect(toolRiskClass({ toolName: "gmail_send_email", viaConnector: true })).toBe(
      "write-external",
    );
    // A declared write wins over a read-looking name.
    expect(
      toolRiskClass({ toolName: "crm_get_contact", viaConnector: true, readOnly: false }),
    ).toBe("write-external");
    // A declared read never relaxes a mutating name.
    expect(
      toolRiskClass({ toolName: "stripe_create_charge", viaConnector: true, readOnly: true }),
    ).toBe("write-external");
  });

  it("denies by default: an unclassified tool with possible side effects is write-external", () => {
    expect(toolRiskClass({ toolName: "brand_new_builtin", viaConnector: false })).toBe(
      "write-external",
    );
    expect(toolRiskClass({ toolName: "acme_frobnicate", viaConnector: true })).toBe(
      "write-external",
    );
  });

  it("keeps every explicitly classed tool in exactly one class", () => {
    const seen = new Map<string, string>();
    for (const riskClass of RISK_CLASSES) {
      for (const tool of EXPLICIT_RISK_CLASSES[riskClass]) {
        expect(seen.get(tool), tool).toBeUndefined();
        seen.set(tool, riskClass);
      }
    }
  });
});

describe("approval policy", () => {
  it("gates write-external by default when the module is on", () => {
    expect(DEFAULT_GATED_CLASSES).toEqual(["write-external"]);
    const policy = resolveApprovalPolicy(null);
    expect(policy).toEqual({ gatedClasses: ["write-external"], approverUserIds: [] });
    expect(approvalRequired(policy, "write-external")).toBe(true);
    expect(approvalRequired(policy, "write-internal")).toBe(false);
    expect(approvalRequired(policy, "read")).toBe(false);
  });

  it("follows the bot's stored classes, dropping unknown ones", () => {
    const policy = resolveApprovalPolicy({
      gatedClasses: ["write-internal", "bogus", "write-external"],
      approverUserIds: ["u2", "u1", "u2"],
    });
    expect(policy).toEqual({
      gatedClasses: ["write-internal", "write-external"],
      approverUserIds: ["u1", "u2"],
    });
    expect(approvalRequired(policy, "write-internal")).toBe(true);
    // An empty stored list is a deliberate "never ask".
    expect(
      approvalRequired(
        resolveApprovalPolicy({ gatedClasses: [], approverUserIds: [] }),
        "write-external",
      ),
    ).toBe(false);
  });

  it("parses a settings patch strictly and ignores unknown fields such as a spaceId", () => {
    expect(
      parseApprovalPolicyPatch({
        gatedClasses: ["write-external", "read"],
        approverUserIds: ["u1"],
        spaceId: "other",
      }),
    ).toEqual({
      ok: true,
      value: { gatedClasses: ["read", "write-external"], approverUserIds: ["u1"] },
    });
    expect(parseApprovalPolicyPatch({ approverUserIds: [] })).toEqual({
      ok: true,
      value: { approverUserIds: [] },
    });
    expect(parseApprovalPolicyPatch({ gatedClasses: ["everything"] })).toEqual({
      ok: false,
      error: "Unknown risk class",
    });
    expect(parseApprovalPolicyPatch({ gatedClasses: "write-external" })).toMatchObject({
      ok: false,
    });
    expect(parseApprovalPolicyPatch({ approverUserIds: [42] })).toMatchObject({ ok: false });
    expect(
      parseApprovalPolicyPatch({ approverUserIds: Array.from({ length: 101 }, (_, i) => `u${i}`) }),
    ).toMatchObject({ ok: false });
    expect(parseApprovalPolicyPatch({})).toEqual({ ok: false, error: "Nothing to change" });
  });
});

describe("approval expiry", () => {
  const requested = new Date("2026-10-15T12:00:00.000Z");

  it("expires thirty minutes after the request", () => {
    expect(APPROVAL_TTL_MS).toBe(30 * 60_000);
    expect(approvalExpiresAt(requested).toISOString()).toBe("2026-10-15T12:30:00.000Z");
  });

  it("is still open a millisecond before and closed at the deadline", () => {
    const expiresAt = approvalExpiresAt(requested);
    expect(isApprovalExpired(expiresAt, new Date(expiresAt.getTime() - 1))).toBe(false);
    expect(isApprovalExpired(expiresAt, expiresAt)).toBe(true);
    expect(isApprovalExpired(expiresAt, new Date(expiresAt.getTime() + 60_000))).toBe(true);
  });
});

describe("approvers", () => {
  const members = ["owner1", "owner2", "member", "requester"];

  it("defaults to the space owners plus the user who started the run", () => {
    expect(
      resolveApprovers({
        configured: [],
        owners: ["owner2", "owner1"],
        requesterId: "requester",
        members,
      }),
    ).toEqual(["owner1", "owner2", "requester"]);
  });

  it("uses the configured list instead, limited to current members of the space", () => {
    expect(
      resolveApprovers({
        configured: ["member", "gone", "member"],
        owners: ["owner1"],
        requesterId: "requester",
        members,
      }),
    ).toEqual(["member"]);
  });

  it("never lists someone who is not a member, even as the requester", () => {
    expect(
      resolveApprovers({ configured: [], owners: ["owner1"], requesterId: "ex", members }),
    ).toEqual(["owner1"]);
  });

  it("checks a decider against the listed approvers and current membership", () => {
    const approvers = ["owner1", "requester"];
    expect(approverStanding({ approvers, members, userId: "owner1" })).toBe("approver");
    expect(approverStanding({ approvers, members, userId: "member" })).toBe("not_listed");
    expect(approverStanding({ approvers, members: ["owner1"], userId: "requester" })).toBe("left");
  });

  it("drops approvers who left the space; none left means the request cannot be decided", () => {
    expect(activeApprovers(["owner1", "requester"], ["requester"])).toEqual(["requester"]);
    expect(activeApprovers(["owner1"], ["member"])).toEqual([]);
  });
});
