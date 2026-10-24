import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { useId, useMemo, useState } from "react";
import { authClient } from "../lib/auth";
import { useCopyText } from "../lib/copy-text";
import { qrSvg } from "../lib/qr-code";
import { manualKeyFromUri, throwOnAuthError } from "../lib/two-factor";

type Enrolment = { uri: string; backupCodes: string[] };

/**
 * Turns on authenticator-app sign-in: password, then the QR code and key, then a code from the
 * app to confirm, then the backup codes, shown this once. `onDone` runs after the codes.
 */
export function TwoFactorSetup({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel?: () => void;
}) {
  const { t } = useLingui();
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, copy] = useCopyText();
  const passwordId = useId();
  const codeId = useId();
  const qr = useMemo(() => (enrolment ? qrSvg(enrolment.uri) : null), [enrolment]);

  async function run(action: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t`Could not continue`);
    } finally {
      setPending(false);
    }
  }

  const start = () =>
    run(async () => {
      const result = await authClient.twoFactor.enable({ password });
      throwOnAuthError(result, t`Could not start two-factor setup`);
      if (!result.data || !("totpURI" in result.data) || !result.data.totpURI)
        throw new Error(t`Could not start two-factor setup`);
      setEnrolment({ uri: result.data.totpURI, backupCodes: result.data.backupCodes ?? [] });
      setPassword("");
    });

  const confirm = () =>
    run(async () => {
      const result = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s+/g, "") });
      throwOnAuthError(result, t`Could not confirm the code`);
      setCode("");
      setConfirmed(true);
    });

  if (enrolment && confirmed) {
    return (
      <div className="space-y-3" data-testid="two-factor-backup-codes">
        <p className="text-[13.5px] text-foreground/75">
          <Trans>Save these backup codes. Each signs you in once if you lose your phone.</Trans>
        </p>
        <ul className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg bg-muted px-4 py-3 font-mono text-[13.5px]">
          {enrolment.backupCodes.map((backupCode) => (
            <li key={backupCode}>{backupCode}</li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => copy(enrolment.backupCodes.join("\n"))}>
            {copied ? <Trans>Copied</Trans> : <Trans>Copy codes</Trans>}
          </Button>
          <Button onClick={onDone}>
            <Trans>I saved them</Trans>
          </Button>
        </div>
      </div>
    );
  }

  if (enrolment && qr) {
    return (
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <p className="text-[13.5px] text-foreground/75">
          <Trans>Scan this with your authenticator app, then enter the code it shows.</Trans>
        </p>
        <svg
          viewBox={`0 0 ${qr.size + 8} ${qr.size + 8}`}
          role="img"
          aria-label={t`QR code for your authenticator app`}
          data-testid="two-factor-qr"
          className="size-48 rounded-lg bg-white"
        >
          <path d={qr.path} className="fill-black" />
        </svg>
        <details className="text-[13px] text-muted-foreground">
          <summary className="cursor-pointer">
            <Trans>Can’t scan it?</Trans>
          </summary>
          <code
            data-testid="two-factor-manual-key"
            className="mt-2 block select-all break-all rounded-md bg-muted px-3 py-2 font-mono text-foreground"
          >
            {manualKeyFromUri(enrolment.uri)}
          </code>
        </details>
        <Field>
          <FieldLabel htmlFor={codeId}>
            <Trans>Code</Trans>
          </FieldLabel>
          <Input
            id={codeId}
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={7}
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
          <Button type="submit" disabled={pending || code.replace(/\s+/g, "").length !== 6}>
            {pending ? <Trans>Checking…</Trans> : <Trans>Confirm</Trans>}
          </Button>
          {onCancel ? (
            <Button type="button" variant="ghost" onClick={onCancel}>
              <Trans>Cancel</Trans>
            </Button>
          ) : null}
        </div>
      </form>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void start();
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
      {error ? (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending || !password}>
          {pending ? <Trans>Working…</Trans> : <Trans>Continue</Trans>}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
        ) : null}
      </div>
    </form>
  );
}
