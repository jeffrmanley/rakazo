import { describe, expect, it } from "vitest";
import {
  APPROVAL_TTL_MS,
  activeApprovers,
  approvalExpiresAt,
  approvalHashLabel,
  approvalRequired,
  approverStanding,
  canonicalArgsText,
  DEFAULT_GATED_CLASSES,
  EXPLICIT_RISK_CLASSES,
  isApprovalExempt,
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
      "archive_bot",
      "forget_secret",
      "launch_app",
      "open_path",
    ]) {
      expect(toolRiskClass({ toolName, viaConnector: false })).toBe("write-internal");
    }
  });

  it("classes the upstream consequential tools that leave the deployment as write-external", () => {
    for (const toolName of ["destination.write", "cloud_agent_launch", "cloud_agent_reply"]) {
      expect(toolRiskClass({ toolName, viaConnector: false })).toBe("write-external");
    }
  });

  it("classes tools that make another bot or a new tool server act as write-external", () => {
    for (const toolName of ["add_mcp_server", "message_bot", "handoff_to_bot", "spawn_bot"]) {
      expect(toolRiskClass({ toolName, viaConnector: false })).toBe("write-external");
    }
  });

  it("never trusts a read-looking name on a tool server the model added", () => {
    expect(
      toolRiskClass({ toolName: "mcp__x__list_items", viaConnector: true, modelAdded: true }),
    ).toBe("write-external");
    expect(
      toolRiskClass({
        toolName: "mcp__x__get_page",
        viaConnector: true,
        readOnly: true,
        modelAdded: true,
      }),
    ).toBe("write-external");
    // A server a person installed keeps the upstream rule.
    expect(toolRiskClass({ toolName: "mcp__x__list_items", viaConnector: true })).toBe("read");
  });

  it("exempts conversation tools from gating entirely", () => {
    for (const tool of ["ask_user", "end_call", "request_secret", "request_takeover"]) {
      expect(isApprovalExempt(tool)).toBe(true);
    }
    for (const tool of ["read_file", "web_fetch", "shell", "destination.write"]) {
      expect(isApprovalExempt(tool)).toBe(false);
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
    const eligible = ["owner1", "requester", "member"];
    const check = (userId: string, overrides: { members?: string[]; eligible?: string[] } = {}) =>
      approverStanding({
        approvers,
        members: overrides.members ?? members,
        eligible: overrides.eligible ?? eligible,
        userId,
      });
    expect(check("owner1")).toBe("approver");
    expect(check("member")).toBe("not_listed");
    expect(check("requester", { members: ["owner1"] })).toBe("left");
    // Still a member, but no longer on the bot's current approver list.
    expect(check("requester", { eligible: ["owner1"] })).toBe("removed");
  });

  it("counts only approvers who are still members and still on the current list", () => {
    expect(activeApprovers(["owner1", "requester"], ["requester"])).toEqual(["requester"]);
    expect(activeApprovers(["owner1"], ["member"])).toEqual([]);
  });
});

describe("canonical arguments", () => {
  it("renders every argument with keys sorted at every depth, like the call hash", () => {
    const text = canonicalArgsText({ to: "a@example.test", body: { z: 1, a: [{ y: 2, b: 3 }] } });
    expect(text).toBe(
      [
        "{",
        '  "body": {',
        '    "a": [',
        "      {",
        '        "b": 3,',
        '        "y": 2',
        "      }",
        "    ],",
        '    "z": 1',
        "  },",
        '  "to": "a@example.test"',
        "}",
      ].join("\n"),
    );
    expect(canonicalArgsText({ b: 1, a: 2 })).toBe(canonicalArgsText({ a: 2, b: 1 }));
  });

  it("labels a call with the first eight hex characters of its hash", () => {
    expect(approvalHashLabel("0123456789abcdef".repeat(4))).toBe("01234567");
  });
});
