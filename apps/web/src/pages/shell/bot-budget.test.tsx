// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotBudgetView } from "../../lib/budgets";

const budgets = vi.hoisted(() => ({
  fetchBotBudget: vi.fn(),
  saveBotBudget: vi.fn(),
  topUpBotBudget: vi.fn(),
}));

vi.mock("../../lib/budgets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/budgets")>()),
  ...budgets,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
    <button {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: { checked: boolean; onCheckedChange: (value: boolean) => void } & ComponentProps<"input">) => (
    <input
      type="checkbox"
      data-testid="premium-switch"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
      {...props}
    />
  ),
}));

import { BotBudgetSection } from "./bot-budget";

function view(overrides: Partial<BotBudgetView> = {}): BotBudgetView {
  return {
    day: "2026-10-15",
    bot: {
      spentUsd: 1.2,
      capUsd: 3,
      topUpUsd: 0,
      level: "ok",
      profile: "assistant",
      customDailyUsd: null,
    },
    space: { spentUsd: 1.2, capUsd: 50, topUpUsd: 0, level: "ok" },
    settings: {
      profile: "assistant",
      customDailyUsd: null,
      premium: false,
      maxConcurrentRuns: null,
      maxSpawnDepth: null,
      maxSpawnFanout: null,
    },
    defaults: { assistantDailyUsd: 3, maxConcurrentRuns: 2, maxSpawnDepth: 2, maxSpawnFanout: 5 },
    canRaise: false,
    canSetPremium: false,
    canTopUp: false,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(<BotBudgetSection botId="bot-1" />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  for (const fn of Object.values(budgets)) fn.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("BotBudgetSection", () => {
  it("shows nothing when the server has budgets off", async () => {
    budgets.fetchBotBudget.mockResolvedValue(null);
    await render();
    expect(container.innerHTML).toBe("");
  });

  it("shows today's spend and saves a profile change; no premium or top-up for a bot owner", async () => {
    budgets.fetchBotBudget.mockResolvedValue(view());
    budgets.saveBotBudget.mockResolvedValue(
      view({ settings: { ...view().settings, profile: "worker" } }),
    );
    await render();
    expect(container.querySelector('[data-testid="bot-budget-spend"]')?.textContent).toBe(
      "$1.20 of $3.00 today",
    );
    expect(container.querySelector('[data-testid="premium-switch"]')).toBeNull();
    expect(container.textContent).not.toContain("Top up today");
    const select = container.querySelector("select")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(
        select,
        "worker",
      );
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(budgets.saveBotBudget).toHaveBeenCalledWith("bot-1", { profile: "worker" });
  });

  it("lets a bot owner only lower the budget: swarm and custom disabled, limits capped", async () => {
    budgets.fetchBotBudget.mockResolvedValue(view());
    await render();
    const options = [...container.querySelectorAll("option")];
    const disabled = Object.fromEntries(options.map((option) => [option.value, option.disabled]));
    expect(disabled).toEqual({ assistant: false, worker: false, swarm: true, custom: true });
    const limits = [...container.querySelectorAll('input[type="number"]')] as HTMLInputElement[];
    expect(limits.map((input) => input.max)).toEqual(["2", "2", "5"]);
  });

  it("lets a space owner raise the budget", async () => {
    budgets.fetchBotBudget.mockResolvedValue(view({ canRaise: true, canSetPremium: true }));
    await render();
    const options = [...container.querySelectorAll("option")];
    expect(options.every((option) => !option.disabled)).toBe(true);
    const limits = [...container.querySelectorAll('input[type="number"]')] as HTMLInputElement[];
    expect(limits.map((input) => input.max)).toEqual(["50", "50", "50"]);
  });

  it("offers premium and a top-up to a space owner once the bot nears its cap", async () => {
    budgets.fetchBotBudget.mockResolvedValue(
      view({
        canSetPremium: true,
        canTopUp: true,
        bot: { ...view().bot, spentUsd: 2.5, level: "warn" },
      }),
    );
    await render();
    expect(container.querySelector('[data-testid="premium-switch"]')).not.toBeNull();
    expect(container.textContent).toContain("Top up today");
  });
});
