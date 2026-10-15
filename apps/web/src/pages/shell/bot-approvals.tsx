import { Trans, useLingui } from "@lingui/react/macro";
import type { RiskClass } from "@rakazo/core";
import { Switch } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import type { BotApprovalsPatch, BotApprovalsView } from "../../lib/approvals";
import { fetchBotApprovals, saveBotApprovals } from "../../lib/approvals";
import { errorText } from "../../lib/user-error";

const rowClass = "mt-3 flex items-center justify-between gap-3";
const labelClass = "text-[14px] text-muted-foreground";

/**
 * Which of a bot's actions wait for a person, and who decides (EXT_APPROVALS). Renders
 * nothing when the server has approvals off or the viewer is not a space owner.
 */
export function BotApprovalsSection({ botId }: { botId: string }) {
  const { t } = useLingui();
  const ids = useId();
  const [view, setView] = useState<BotApprovalsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setView(null);
    fetchBotApprovals(botId)
      .then((next) => {
        if (live) setView(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [botId]);

  if (!view) return null;

  const save = async (patch: BotApprovalsPatch) => {
    setError(null);
    try {
      const next = await saveBotApprovals(botId, patch);
      if (next) setView(next);
    } catch (caught) {
      setError(errorText(caught));
      setView({ ...view });
    }
  };

  const classLabels: Record<RiskClass, string> = {
    read: t`Reads`,
    "write-internal": t`Internal changes`,
    "write-external": t`External actions`,
  };
  const { gatedClasses, approverUserIds } = view.policy;

  return (
    <details data-testid="bot-approvals" className="group mt-5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[14px] text-muted-foreground">
        <Trans>Approvals</Trans>
        <span aria-hidden="true" className="transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      {view.riskClasses.map((riskClass) => (
        <div key={riskClass} className={rowClass}>
          <span id={`${ids}-${riskClass}`} className={labelClass}>
            {classLabels[riskClass]}
          </span>
          <Switch
            checked={gatedClasses.includes(riskClass)}
            aria-labelledby={`${ids}-${riskClass}`}
            onCheckedChange={(on) =>
              void save({
                gatedClasses: view.riskClasses.filter((each) =>
                  each === riskClass ? on : gatedClasses.includes(each),
                ),
              })
            }
          />
        </div>
      ))}
      <p className="mt-4 text-[14px] text-muted-foreground">
        <Trans>Approvers</Trans>
      </p>
      {approverUserIds.length === 0 ? (
        <p className="mt-1 text-[12px] text-muted-foreground/70">
          <Trans>Space owners and the requester</Trans>
        </p>
      ) : null}
      {view.members.map((member) => (
        <div key={member.userId} className={rowClass}>
          <span id={`${ids}-member-${member.userId}`} className={labelClass}>
            {member.name}
          </span>
          <Switch
            checked={approverUserIds.includes(member.userId)}
            aria-labelledby={`${ids}-member-${member.userId}`}
            onCheckedChange={(on) =>
              void save({
                approverUserIds: on
                  ? [...approverUserIds, member.userId]
                  : approverUserIds.filter((id) => id !== member.userId),
              })
            }
          />
        </div>
      ))}
      {error ? (
        <p role="alert" className="mt-2 text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
    </details>
  );
}
