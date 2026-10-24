import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Field, FieldLabel, Input, Label, Switch } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { TwoFactorSetup } from "../components/TwoFactorSetup";
import { rpc } from "../lib/rpc";
import { disableTwoFactor, refreshTwoFactorPolicy, useTwoFactorPolicy } from "../lib/two-factor";
import { errorText } from "../lib/user-error";

/** Settings → Security: authenticator-app sign-in, and the owner's policy for everyone. */
export function SecuritySettingsPanel({
  isDeploymentOwner = false,
}: {
  isDeploymentOwner?: boolean;
}) {
  const policy = useTwoFactorPolicy();
  const [setup, setSetup] = useState(false);
  const [disabling, setDisabling] = useState(false);

  return (
    <div className="space-y-5">
      <section
        data-testid="two-factor-settings"
        className="rounded-xl border border-border px-4 py-4"
      >
        <h3 className="text-[15px] font-medium text-foreground">
          <Trans>Two-factor authentication</Trans>
        </h3>
        {!policy ? (
          <p role="status" className="mt-3 text-[13px] text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        ) : !policy.available ? (
          <p className="mt-3 text-[13px] text-muted-foreground">
            <Trans>Your account signs in with SSO, which handles its own second factor.</Trans>
          </p>
        ) : policy.enabled ? (
          <div className="mt-3 space-y-3">
            <p className="text-[13.5px] text-foreground/75" data-testid="two-factor-status">
              <Trans>On. Signing in asks for a code from your authenticator app.</Trans>
            </p>
            {disabling ? (
              <DisableTwoFactor
                onCancel={() => setDisabling(false)}
                onDone={() => {
                  setDisabling(false);
                  void refreshTwoFactorPolicy();
                }}
              />
            ) : (
              <Button variant="outline" onClick={() => setDisabling(true)}>
                <Trans>Turn off</Trans>
              </Button>
            )}
          </div>
        ) : setup ? (
          <div className="mt-3">
            <TwoFactorSetup
              onCancel={() => setSetup(false)}
              onDone={() => {
                setSetup(false);
                void refreshTwoFactorPolicy();
              }}
            />
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <p className="text-[13.5px] text-foreground/75" data-testid="two-factor-status">
              <Trans>Off.</Trans>
            </p>
            <Button onClick={() => setSetup(true)}>
              <Trans>Turn on</Trans>
            </Button>
          </div>
        )}
      </section>
      {isDeploymentOwner ? <RequireForEveryone /> : null}
    </div>
  );
}

function DisableTwoFactor({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useLingui();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordId = useId();
  const codeId = useId();

  async function submit() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await disableTwoFactor(password, code);
      onDone();
    } catch (failure) {
      setError(errorText(failure, t`Could not turn off two-factor sign-in`));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Field>
        <FieldLabel htmlFor={passwordId}>
          <Trans>Current password</Trans>
        </FieldLabel>
        <Input
          id={passwordId}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={codeId}>
          <Trans>Code or backup code</Trans>
        </FieldLabel>
        <Input
          id={codeId}
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </Field>
      {error ? (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="destructive" disabled={pending || !password || !code.trim()}>
          {pending ? <Trans>Working…</Trans> : <Trans>Turn off two-factor sign-in</Trans>}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
    </form>
  );
}

function RequireForEveryone() {
  const { t } = useLingui();
  const [value, setValue] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  useEffect(() => {
    let active = true;
    rpc.deployment
      .get()
      .then((settings) => {
        if (active) setValue(settings.require2faForAll);
      })
      .catch(() => {
        if (active) setError(t`Could not load this setting`);
      });
    return () => {
      active = false;
    };
  }, []);

  async function change(next: boolean) {
    setPending(true);
    setError(null);
    try {
      setValue((await rpc.deployment.update({ require2faForAll: next })).require2faForAll);
    } catch (failure) {
      setError(errorText(failure, t`Could not save this setting`));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-xl border border-border px-4 py-4">
      <div className="flex items-start gap-3">
        <Switch
          id={id}
          data-testid="require-two-factor-toggle"
          className="mt-0.5"
          checked={value === true}
          disabled={value === null || pending}
          onCheckedChange={(checked) => void change(checked)}
        />
        <Label htmlFor={id} className="text-[14px] font-normal text-foreground/75">
          <Trans>Require two-factor sign-in for every account</Trans>
        </Label>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
