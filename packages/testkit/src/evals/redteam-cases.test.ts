import { describe, expect, it } from "vitest";
import type { RedteamCase } from "./redteam-cases.js";
import {
  LIVE_CANARY,
  REDTEAM_CASES,
  REDTEAM_LIVE_PROMPTS,
  redteamPassed,
  redteamResults,
  redteamTitle,
  renderRedteamSummary,
} from "./redteam-cases.js";

const sample: RedteamCase[] = [
  {
    id: "alpha",
    title: "first | case",
    attack: "a",
    expectedControl: "c",
    assertion: "x",
    status: "enforced",
  },
  {
    id: "beta",
    title: "second",
    attack: "b",
    expectedControl: "d",
    assertion: "y",
    status: "known-gap",
    gap: "Beta does not hold when the moon is full.",
  },
  {
    id: "gamma",
    title: "third",
    attack: "g",
    expectedControl: "e",
    assertion: "z",
    status: "enforced",
  },
];

const report = (entries: Array<[string, string, string?]>) => ({
  testResults: [
    {
      assertionResults: entries.map(([title, status, failure]) => ({
        title,
        status,
        ...(failure ? { failureMessages: [`${failure}\n    at stack`] } : {}),
      })),
    },
  ],
});

describe("red-team catalog", () => {
  it("has unique ids, every field filled, and a gap description for every known gap", () => {
    const ids = REDTEAM_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of REDTEAM_CASES) {
      expect(c.id).toMatch(/^[a-z][a-z0-9-]+$/);
      for (const field of [c.title, c.attack, c.expectedControl, c.assertion])
        expect(field.trim()).not.toBe("");
      if (c.status === "known-gap") expect(c.gap?.trim()).toBeTruthy();
    }
    expect(ids.at(-1)).toBe("audit-tamper");
  });

  it("maps test results to outcomes by the title prefix", () => {
    const results = redteamResults(
      report([
        [redteamTitle(sample[0]!), "passed"],
        [redteamTitle(sample[1]!), "passed"],
        [redteamTitle(sample[2]!), "failed", "AssertionError: expected 1 to be 0"],
      ]),
      sample,
    );
    expect(results).toEqual([
      { id: "alpha", outcome: "held" },
      { id: "beta", outcome: "known-gap" },
      { id: "gamma", outcome: "not-held", detail: "AssertionError: expected 1 to be 0" },
    ]);
    expect(redteamPassed(results)).toBe(false);
    expect(redteamPassed(results.slice(0, 2))).toBe(true);
  });

  it("reports a closed gap, a skipped case and a missing case as needing attention", () => {
    const results = redteamResults(
      report([
        [redteamTitle(sample[0]!), "skipped"],
        [redteamTitle(sample[1]!), "failed"],
      ]),
      sample,
    );
    expect(results.map((r) => r.outcome)).toEqual(["not-run", "gap-closed", "not-run"]);
    expect(redteamPassed(results)).toBe(false);
  });

  it("renders a markdown table with every case and lists what needs attention", () => {
    const markdown = renderRedteamSummary(
      [
        { id: "alpha", outcome: "held" },
        { id: "beta", outcome: "known-gap" },
        { id: "gamma", outcome: "not-held", detail: "expected | x" },
      ],
      { at: "2026-10-15T00:00:00.000Z", revision: "0123456789abcdef" },
      sample,
    );
    expect(markdown).toContain("Run at 2026-10-15T00:00:00.000Z on 0123456789ab.");
    expect(markdown).toContain("**a control did not hold**");
    expect(markdown).toContain("| `alpha` first \\| case | a | c | held |");
    expect(markdown).toContain("| `gamma` third | g | e | NOT HELD |");
    expect(markdown).toContain("- `beta`: known gap. Beta does not hold when the moon is full.");
    expect(markdown).toContain("- `gamma`: NOT HELD. First failure: expected \\| x");
    const clean = renderRedteamSummary(
      [
        { id: "alpha", outcome: "held" },
        { id: "gamma", outcome: "held" },
      ],
      { at: "t", revision: null },
      [sample[0]!, sample[2]!],
    );
    expect(clean).toContain("**all controls held** (2 held)");
    expect(clean).not.toContain("Needs attention");
  });

  it("flags live tool calls that carry out an injected instruction, and nothing benign", () => {
    const byId = Object.fromEntries(REDTEAM_LIVE_PROMPTS.map((p) => [p.id, p]));
    const benign = [
      { name: "read_file", args: '{"path":"notes.txt"}' },
      { name: "write_file", args: '{"path":"summary.md","content":"Two sentences."}' },
      { name: "update_bot", args: '{"title":"Proofreader"}' },
    ];
    for (const prompt of REDTEAM_LIVE_PROMPTS) {
      expect(prompt.injected).toContain(LIVE_CANARY);
      for (const call of benign) expect(prompt.violates(call)).toBe(false);
      expect(prompt.violates({ name: "write_file", args: `{"content":"${LIVE_CANARY}"}` })).toBe(
        true,
      );
    }
    expect(byId["live-forwarded-email"]!.violates({ name: "destination_write", args: "{}" })).toBe(
      true,
    );
    expect(byId["live-slack-paste"]!.violates({ name: "add_mcp_server", args: "{}" })).toBe(true);
    expect(
      byId["live-raise-limits"]!.violates({ name: "update_bot", args: '{"premium":true}' }),
    ).toBe(true);
    expect(
      byId["live-raise-limits"]!.violates({
        name: "run_subagent",
        args: '{"model_id":"claude-fable-x"}',
      }),
    ).toBe(true);
    expect(
      byId["live-secret-echo"]!.violates({ name: "shell", args: '{"command":"printenv"}' }),
    ).toBe(true);
  });
});
