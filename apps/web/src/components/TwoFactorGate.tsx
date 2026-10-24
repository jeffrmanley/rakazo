import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Dialog, DialogContent, DialogTitle } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { useState } from "react";
import { authClient } from "../lib/auth";
import { refreshTwoFactorPolicy, useTwoFactorPolicy } from "../lib/two-factor";
import { BrandLogo } from "./BrandLogo";
import { TwoFactorSetup } from "./TwoFactorSetup";

/**
 * Deployment two-factor policy on every signed-in page. The owner keeps working under a banner
 * until they enrol, so the rollout cannot lock them out; when the owner requires it for every
 * account, anyone else enrols here first (the API refuses their other requests until then).
 */
export function TwoFactorGate({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  const policy = useTwoFactorPolicy();
  const [open, setOpen] = useState(false);

  if (policy?.enforcement === "enrol") return <RequiredEnrolment />;
  const banner = policy?.enforcement === "banner";
  // One tree with or without the banner, so it can come and go without remounting the app.
  return (
    <div className="flex h-full flex-col">
      {banner ? (
        <section
          aria-label={t`Two-factor authentication`}
          data-testid="two-factor-banner"
          className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-border bg-muted px-4 py-2 text-[13.5px] text-foreground"
        >
          <span>
            <Trans>Turn on two-factor sign-in to protect this deployment.</Trans>
          </span>
          <Button size="sm" onClick={() => setOpen(true)}>
            <Trans>Turn on</Trans>
          </Button>
        </section>
      ) : null}
      <div className="min-h-0 flex-1">{children}</div>
      {banner && open ? (
        <Dialog open onOpenChange={(next) => (next ? undefined : setOpen(false))}>
          <DialogContent className="max-w-md">
            <DialogTitle>
              <Trans>Two-factor authentication</Trans>
            </DialogTitle>
            <TwoFactorSetup
              onCancel={() => setOpen(false)}
              onDone={() => {
                setOpen(false);
                void refreshTwoFactorPolicy();
              }}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function RequiredEnrolment() {
  return (
    <div
      className="flex min-h-full items-center justify-center bg-background px-6 py-16 text-foreground"
      data-testid="two-factor-required"
    >
      <div className="flex w-[460px] max-w-full flex-col">
        <BrandLogo className="size-[74px] self-center">
          <div className="flex h-[74px] w-[74px] items-center justify-center gap-[11px] rounded-full bg-muted">
            <span className="h-5 w-[9px] rounded-full bg-primary" />
            <span className="h-5 w-[9px] rounded-full bg-primary" />
          </div>
        </BrandLogo>
        <h1 className="mb-3 mt-7 text-center text-3xl font-medium tracking-tight">
          <Trans>Set up two-factor sign-in</Trans>
        </h1>
        <p className="mb-8 text-center text-muted-foreground">
          <Trans>This deployment requires it for every account.</Trans>
        </p>
        <TwoFactorSetup onDone={() => void refreshTwoFactorPolicy()} />
        <Button
          variant="link"
          className="mt-6 self-center text-muted-foreground"
          onClick={() =>
            void authClient.signOut().finally(() => window.location.assign("/sign-in"))
          }
        >
          <Trans>Log out</Trans>
        </Button>
      </div>
    </div>
  );
}
