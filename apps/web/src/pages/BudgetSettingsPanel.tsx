import { Trans, useLingui } from "@lingui/react/macro";
import { formatUsd } from "@rakazo/core";
import { Button, Input } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import type { SpaceBudgetView } from "../lib/budgets";
import { fetchSpaceBudget, parseUsdInput, saveSpaceBudget, topUpSpaceBudget } from "../lib/budgets";
import { errorText } from "../lib/user-error";

/** The space's daily cap and today's spend; space owners can change the cap and top up today. */
export function BudgetSettingsPanel({ initial }: { initial: SpaceBudgetView }) {
  const { t } = useLingui();
  const ids = useId();
  const [view, setView] = useState(initial);
  const [capDraft, setCapDraft] = useState(initial.custom ? String(initial.baseUsd) : "");
  const [topUpDraft, setTopUpDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const canManage = Boolean(view.canManage);

  useEffect(() => setCapDraft(view.custom ? String(view.baseUsd) : ""), [view]);

  const refresh = async () => {
    const next = await fetchSpaceBudget();
    if (next) setView(next);
  };

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  const spent = formatUsd(view.spentUsd);
  const cap = formatUsd(view.capUsd);

  return (
    <div data-testid="budget-settings" className="max-w-[520px] space-y-6">
      <p
        data-testid="space-budget-spend"
        className={`text-[14px] ${view.level === "ok" ? "text-foreground" : "text-destructive"}`}
      >
        {t`${spent} of ${cap} today`}
      </p>
      {canManage ? (
        <>
          <label htmlFor={`${ids}-cap`} className="block text-[14px] text-muted-foreground">
            <Trans>Daily cap (USD)</Trans>
            <Input
              id={`${ids}-cap`}
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              placeholder={String(view.baseUsd)}
              value={capDraft}
              onChange={(event) => setCapDraft(event.target.value)}
              onBlur={() => {
                const amount = parseUsdInput(capDraft);
                if (amount === (view.custom ? view.baseUsd : null)) return;
                void run(() => saveSpaceBudget(amount));
              }}
              className="mt-1.5"
            />
          </label>
          <div className="flex gap-2">
            <Input
              aria-label={t`Top-up amount in USD`}
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              value={topUpDraft}
              onChange={(event) => setTopUpDraft(event.target.value)}
              className="flex-1"
            />
            <Button
              variant="outline"
              disabled={parseUsdInput(topUpDraft) === null}
              onClick={() => {
                const amount = parseUsdInput(topUpDraft);
                if (amount === null) return;
                void run(async () => {
                  await topUpSpaceBudget(amount);
                  setTopUpDraft("");
                });
              }}
            >
              <Trans>Top up today</Trans>
            </Button>
          </div>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
