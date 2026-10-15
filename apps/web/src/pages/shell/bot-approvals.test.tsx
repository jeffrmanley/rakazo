// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotApprovalsView } from "../../lib/approvals";

const approvals = vi.hoisted(() => ({
  fetchBotApprovals: vi.fn(),
  saveBotApprovals: vi.fn(),
}));

vi.mock("../../lib/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/approvals")>()),
  ...approvals,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: { checked: boolean; onCheckedChange: (value: boolean) => void } & ComponentProps<"input">) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
      {...props}
    />
  ),
}));

import { BotApprovalsSection } from "./bot-approvals";

function view(overrides: Partial<BotApprovalsView["policy"]> = {}): BotApprovalsView {
  return {
    policy: { gatedClasses: ["write-external"], approverUserIds: [], ...overrides },
    defaults: { gatedClasses: ["write-external"] },
    riskClasses: ["read", "write-internal", "write-external"],
    members: [
      { userId: "u-owner", name: "Ada Owner", owner: true },
      { userId: "u-member", name: "Max Member", owner: false },
    ],
  };
}

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(<BotApprovalsSection botId="bot-1" />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function switchFor(label: string): HTMLInputElement {
  const labelled = [...container.querySelectorAll("input")].find((input) => {
    const id = input.getAttribute("aria-labelledby");
    return id && container.querySelector(`[id="${id}"]`)?.textContent === label;
  });
  if (!labelled) throw new Error(`no switch for ${label}`);
  return labelled as HTMLInputElement;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  for (const fn of Object.values(approvals)) fn.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("BotApprovalsSection", () => {
  it("shows nothing when the module is off or the viewer is not a space owner", async () => {
    approvals.fetchBotApprovals.mockResolvedValue(null);
    await render();
    expect(container.innerHTML).toBe("");
  });

  it("shows the gated classes and saves a change", async () => {
    approvals.fetchBotApprovals.mockResolvedValue(view());
    approvals.saveBotApprovals.mockResolvedValue(
      view({ gatedClasses: ["write-internal", "write-external"] }),
    );
    await render();
    expect(switchFor("External actions").checked).toBe(true);
    expect(switchFor("Internal changes").checked).toBe(false);
    expect(switchFor("Reads").checked).toBe(false);
    await act(async () => {
      switchFor("Internal changes").click();
    });
    expect(approvals.saveBotApprovals).toHaveBeenCalledWith("bot-1", {
      gatedClasses: ["write-internal", "write-external"],
    });
    expect(switchFor("Internal changes").checked).toBe(true);
  });

  it("says that the computer can still reach outside while only External actions are gated", async () => {
    const note =
      "Shell and browser can still reach outside. For high-risk bots, also gate Internal changes.";
    approvals.fetchBotApprovals.mockResolvedValue(view());
    approvals.saveBotApprovals.mockResolvedValue(
      view({ gatedClasses: ["write-internal", "write-external"] }),
    );
    await render();
    expect(container.textContent).toContain(note);
    await act(async () => {
      switchFor("Internal changes").click();
    });
    expect(container.textContent).not.toContain(note);
  });

  it("chooses approvers; none chosen means the space owners and the requester", async () => {
    approvals.fetchBotApprovals.mockResolvedValue(view());
    approvals.saveBotApprovals.mockResolvedValue(view({ approverUserIds: ["u-member"] }));
    await render();
    expect(container.textContent).toContain("Space owners and the requester");
    await act(async () => {
      switchFor("Max Member").click();
    });
    expect(approvals.saveBotApprovals).toHaveBeenCalledWith("bot-1", {
      approverUserIds: ["u-member"],
    });
    expect(container.textContent).not.toContain("Space owners and the requester");
  });

  it("shows the server's reason when a change is refused, and keeps the saved state", async () => {
    approvals.fetchBotApprovals.mockResolvedValue(view());
    approvals.saveBotApprovals.mockRejectedValue(new Error("Only a space owner can change this"));
    await render();
    await act(async () => {
      switchFor("Reads").click();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Only a space owner can change this",
    );
    expect(switchFor("Reads").checked).toBe(false);
  });
});
