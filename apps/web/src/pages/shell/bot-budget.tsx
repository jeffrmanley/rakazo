import { Trans, useLingui } from "@lingui/react/macro";
import type { BudgetProfile } from "@rakazo/core";
import {
  BUDGET_PROFILE_DAILY_USD,
  BUDGET_PROFILES,
  formatUsd,
  isBudgetProfile,
} from "@rakazo/core";
import { Button, Input, NativeSelect, NativeSelectOption, Switch } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import type { BotBudgetPatch, BotBudgetView } from "../../lib/budgets";
import {
  fetchBotBudget,
  parseLimitInput,
  parseUsdInput,
  saveBotBudget,
  topUpBotBudget,
} from "../../lib/budgets";
import { errorText } from "../../lib/user-error";

const fieldLabelClass = "mt-4 block text-[14px] text-muted-foreground";
const LIMIT_KEYS = ["maxConcurrentRuns", "maxSpawnDepth", "maxSpawnFanout"] as const;

/**
 * Daily budget, premium and run limits for one bot (EXT_BUDGETS). Renders nothing when
 * the server has budgets off or the viewer may not edit this bot.
 */
export function BotBudgetSection({ botId }: { botId: string }) {
  const { t } = useLingui();
  const ids = useId();
  const [view, setView] = useState<BotBudgetView | null>(null);
  const [customDraft, setCustomDraft] = useState("");
  const [limitDrafts, setLimitDrafts] = useState<Record<string, string>>({});
  const [topUpDraft, setTopUpDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setView(null);
    fetchBotBudget(botId)
      .then((next) => {
        if (live) setView(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [botId]);

  // Drafts follow the saved settings; a refused save snaps them back.
  useEffect(() => {
    if (!view) return;
    setCustomDraft(view.settings.customDailyUsd?.toString() ?? "");
    setLimitDrafts(
      Object.fromEntries(LIMIT_KEYS.map((key) => [key, view.settings[key]?.toString() ?? ""])),
    );
  }, [view]);

  if (!view) return null;

  const save = async (patch: BotBudgetPatch) => {
    setError(null);
    try {
      setView(await saveBotBudget(botId, patch));
    } catch (caught) {
      setError(errorText(caught));
      setView({ ...view });
    }
  };

  const topUp = async () => {
    const amountUsd = parseUsdInput(topUpDraft);
    if (amountUsd === null) return;
    setError(null);
    try {
      await topUpBotBudget(botId, amountUsd);
      setTopUpDraft("");
      setView(await fetchBotBudget(botId));
    } catch (caught) {
      setError(errorText(caught));
    }
  };

  const profileLabel = (profile: BudgetProfile) => {
    switch (profile) {
      case "assistant": {
        const amount = formatUsd(view.defaults.assistantDailyUsd);
        return t`Assistant (${amount})`;
      }
      case "worker": {
        const amount = formatUsd(BUDGET_PROFILE_DAILY_USD.worker);
        return t`Worker (${amount})`;
      }
      case "swarm": {
        const amount = formatUsd(BUDGET_PROFILE_DAILY_USD.swarm);
        return t`Swarm (${amount})`;
      }
      default:
        return t`Custom`;
    }
  };

  const spent = formatUsd(view.bot.spentUsd);
  const cap = formatUsd(view.bot.capUsd);
  const limitLabels = {
    maxConcurrentRuns: t`Runs at once`,
    maxSpawnDepth: t`Delegation depth`,
    maxSpawnFanout: t`Delegations per run`,
  };

  return (
    <div data-testid="bot-budget" className="mt-6 border-t border-border/20 pt-4">
      <label htmlFor={`${ids}-profile`} className="block text-[14px] text-muted-foreground">
        <span className="flex items-baseline justify-between gap-3">
          <Trans>Daily budget</Trans>
          <span
            data-testid="bot-budget-spend"
            className={`text-[12px] ${view.bot.level === "ok" ? "text-muted-foreground/70" : "text-destructive"}`}
          >
            {t`${spent} of ${cap} today`}
          </span>
        </span>
        <NativeSelect
          id={`${ids}-profile`}
          className="mt-2 w-full"
          value={view.settings.profile}
          onChange={(event) => {
            const profile = event.target.value;
            if (!isBudgetProfile(profile)) return;
            if (profile === "custom") {
              const amount = parseUsdInput(customDraft) ?? view.bot.capUsd - view.bot.topUpUsd;
              void save({ profile, customDailyUsd: amount });
            } else void save({ profile });
          }}
        >
          {BUDGET_PROFILES.map((profile) => (
            <NativeSelectOption key={profile} value={profile}>
              {profileLabel(profile)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      {view.settings.profile === "custom" ? (
        <Input
          aria-label={t`Daily budget in USD`}
          type="number"
          inputMode="decimal"
          min="0.01"
          step="0.01"
          value={customDraft}
          onChange={(event) => setCustomDraft(event.target.value)}
          onBlur={() => {
            const amount = parseUsdInput(customDraft);
            if (amount !== null && amount !== view.settings.customDailyUsd) {
              void save({ customDailyUsd: amount });
            }
          }}
          className="mt-2"
        />
      ) : null}
      {view.canTopUp && view.bot.level !== "ok" ? (
        <div className="mt-2 flex gap-2">
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
            onClick={() => void topUp()}
          >
            <Trans>Top up today</Trans>
          </Button>
        </div>
      ) : null}
      {view.canSetPremium ? (
        <div className="mt-4 flex items-center justify-between">
          <span id={`${ids}-premium`} className="text-[14px] text-muted-foreground">
            <Trans>Premium models</Trans>
          </span>
          <Switch
            checked={view.settings.premium}
            aria-labelledby={`${ids}-premium`}
            onCheckedChange={(premium) => void save({ premium })}
          />
        </div>
      ) : null}
      <details className="group mt-4">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] text-muted-foreground">
          <Trans>Limits</Trans>
          <span aria-hidden="true" className="transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        {LIMIT_KEYS.map((key) => (
          <label key={key} htmlFor={`${ids}-${key}`} className={fieldLabelClass}>
            {limitLabels[key]}
            <Input
              id={`${ids}-${key}`}
              type="number"
              inputMode="numeric"
              min="0"
              step="1"
              placeholder={String(view.defaults[key])}
              value={limitDrafts[key] ?? ""}
              onChange={(event) =>
                setLimitDrafts((drafts) => ({ ...drafts, [key]: event.target.value }))
              }
              onBlur={() => {
                const value = parseLimitInput(limitDrafts[key] ?? "");
                if (value !== undefined && value !== view.settings[key]) {
                  void save({ [key]: value });
                }
              }}
              className="mt-1.5"
            />
          </label>
        ))}
      </details>
      {error ? (
        <p role="alert" className="mt-2 text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
