import { Trans, useLingui } from "@lingui/react/macro";
import { credentialIssue, signupRequiresEmailVerification } from "@rakazo/core";
import { Button, Checkbox, Input, Label } from "@rakazo/ui-web";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { BrandLogo } from "../components/BrandLogo";
import { authClient } from "../lib/auth";
import type { AuthCapabilities } from "../lib/auth-capabilities";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { useBrand } from "../lib/brand";
import { clearSpaceSelection } from "../lib/rpc";
import { runSsoFlow } from "../lib/sso-flow";
import { isAuthenticatorCode } from "../lib/two-factor";
import { authErrorText, credentialIssueText } from "../lib/user-error";

type AuthMode = "in" | "up" | "forgot";

const fieldClass = "mt-2 h-12 rounded-xl px-4 text-base md:text-base";
export const submitClass = "mt-3 h-12 w-full rounded-xl text-base";

export function AuthPage({ mode }: { mode: AuthMode }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const code = searchParams.get("error");
    if (!code) return null;
    return authErrorText({ code }, t`Could not continue`);
  });
  const [pending, setPending] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  // Password accepted, second factor pending (Better Auth's two-factor redirect).
  const [challenge, setChallenge] = useState(false);
  const [code, setCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);
  // Signup triggers a session refresh that remounts the anonymous auth page.
  const sent = resetSent || searchParams.get("verify") === "email";
  const [reset, setReset] = useState<AuthCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState(false);
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const passwordFieldId = mode === "in" ? "current-password" : "new-password";
  const brandName = useBrand().name;
  const title = sent ? (
    <Trans>Check your email</Trans>
  ) : challenge ? (
    <Trans>Enter your code</Trans>
  ) : mode === "in" ? (
    <Trans>Sign in to {brandName}</Trans>
  ) : mode === "up" ? (
    <Trans>Create your {brandName}</Trans>
  ) : (
    <Trans>Reset your password</Trans>
  );

  useEffect(() => {
    setReset(null);
    setCapabilityError(false);
    let active = true;
    void fetchAuthCapabilities()
      .then((capabilities) => {
        if (active) setReset(capabilities);
      })
      .catch(() => {
        if (active) setCapabilityError(true);
      });
    return () => {
      // Do not abort on unmount: a guard redirect that bounces through this
      // page only mounts it for a render or two, and the cancelled fetch then
      // surfaces as a failed request. `active` drops the result; the request
      // keeps its own time bound.
      active = false;
    };
  }, [mode, capabilityAttempt]);

  const destination = () =>
    mode === "up"
      ? "/onboarding"
      : searchParams.get("next") === "/integrations/setup"
        ? "/integrations/setup"
        : "/app";

  async function verifySecondFactor() {
    const value = useBackupCode ? code.trim() : code.replace(/\s+/g, "");
    if (!value) return;
    setPending(true);
    setError(null);
    try {
      const result = useBackupCode
        ? await authClient.twoFactor.verifyBackupCode({ code: value, trustDevice })
        : await authClient.twoFactor.verifyTotp({ code: value, trustDevice });
      if (result.error) {
        // The pending sign-in is used up; only a new password sign-in starts another.
        if (
          result.error.code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" ||
          result.error.code === "INVALID_TWO_FACTOR_COOKIE"
        ) {
          setChallenge(false);
          setCode("");
        }
        setError(authErrorText(result.error, t`Could not continue`));
        return;
      }
      clearSpaceSelection();
      navigate(destination());
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (challenge) {
      await verifySecondFactor();
      return;
    }
    if (!reset?.passwordAuth) return;
    const issue = credentialIssue({ email, password: mode === "forgot" ? undefined : password });
    if (issue) {
      setError(credentialIssueText(issue));
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (mode === "forgot") {
        if (!reset?.passwordReset || !reset.resetUrl) {
          setError(t`Password recovery is not configured for this server`);
          return;
        }
        const result = await authClient.requestPasswordReset({
          email: email.trim(),
          redirectTo: reset.resetUrl,
        });
        if (result.error) {
          setError(authErrorText(result.error, t`Could not send reset email`));
          return;
        }
        setResetSent(true);
        return;
      }
      const trimmedEmail = email.trim();
      const result =
        mode === "up"
          ? await authClient.signUp.email({
              email: trimmedEmail,
              password,
              name: name || trimmedEmail.split("@")[0] || "User",
            })
          : // Held back: a refetch that finds no session unmounts this page, and an account with
            // two-factor gets no session until the code step below.
            await authClient.signIn.email(
              { email: trimmedEmail, password },
              { disableSignal: true },
            );
      if (result.error) {
        setError(authErrorText(result.error, t`Could not continue`));
        return;
      }
      if (mode === "up" && signupRequiresEmailVerification(result.data)) {
        setSearchParams({ verify: "email" });
        return;
      }
      if (needsSecondFactor(result.data)) {
        setPassword("");
        setCode("");
        setChallenge(true);
        return;
      }
      if (mode === "in") authClient.$store.notify("$sessionSignal");
      clearSpaceSelection();
      navigate(destination());
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  async function signInWithSso() {
    setError(null);
    try {
      const result = await runSsoFlow(
        (disableRedirect, callbackURL) =>
          authClient.signIn.social({
            disableRedirect,
            provider: "oidc",
            newUserCallbackURL: callbackURL("/onboarding"),
            callbackURL: callbackURL(
              searchParams.get("next") === "/integrations/setup" ? "/integrations/setup" : "/app",
            ),
            errorCallbackURL: callbackURL("/sign-in"),
          }),
        ["/app", "/onboarding", "/integrations/setup", "/sign-in"],
      );
      if (result.error) setError(authErrorText(result.error, t`Could not continue`));
    } catch {
      setError(t`Could not continue`);
    }
  }

  return (
    <AuthFrame onSubmit={submit} title={title}>
      {sent ? (
        <div className="w-full text-center">
          <Link to="/sign-in" className="font-medium text-foreground">
            <Trans>Back to sign in</Trans>
          </Link>
        </div>
      ) : challenge ? (
        <>
          <div className="w-full">
            <Label htmlFor="two-factor-code" className="text-muted-foreground">
              {useBackupCode ? <Trans>Backup code</Trans> : <Trans>Authenticator code</Trans>}
            </Label>
            <Input
              id="two-factor-code"
              name="code"
              autoComplete="one-time-code"
              inputMode={useBackupCode ? "text" : "numeric"}
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={fieldClass}
            />
          </div>
          <div className="mt-4 flex w-full items-center gap-2">
            <Checkbox
              id="trust-device"
              checked={trustDevice}
              onCheckedChange={(checked) => setTrustDevice(checked === true)}
            />
            <Label htmlFor="trust-device" className="font-normal text-muted-foreground">
              <Trans>Trust this device for 30 days</Trans>
            </Label>
          </div>
          {error ? (
            <p role="alert" className="mt-3 w-full text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            disabled={pending || (useBackupCode ? !code.trim() : !isAuthenticatorCode(code))}
            className={submitClass}
          >
            {pending ? <Trans>Working…</Trans> : <Trans>Verify</Trans>}
          </Button>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="mt-3 text-muted-foreground"
            onClick={() => {
              setUseBackupCode((value) => !value);
              setCode("");
              setError(null);
            }}
          >
            {useBackupCode ? (
              <Trans>Use your authenticator app</Trans>
            ) : (
              <Trans>Use a backup code</Trans>
            )}
          </Button>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="mt-6 text-foreground"
            onClick={() => {
              setChallenge(false);
              setCode("");
              setError(null);
            }}
          >
            <Trans>Back to sign in</Trans>
          </Button>
        </>
      ) : (
        <>
          {capabilityError ? (
            <div role="alert" className="w-full text-center">
              <p>
                <Trans>Could not load sign-in options</Trans>
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCapabilityAttempt((attempt) => attempt + 1)}
              >
                <Trans>Retry</Trans>
              </Button>
            </div>
          ) : !reset ? (
            <p role="status">
              <Trans>Loading…</Trans>
            </p>
          ) : null}
          {reset?.sso && !reset.passwordAuth && mode !== "forgot" ? (
            <Button
              type="button"
              disabled={pending}
              className={submitClass}
              onClick={() => void signInWithSso()}
            >
              <Trans>Continue with {reset.sso.name}</Trans>
            </Button>
          ) : null}
          {error && !reset?.passwordAuth ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {reset?.passwordAuth ? (
            <>
              {mode === "up" ? (
                <div className="mb-4 w-full">
                  <Label htmlFor="name" className="text-muted-foreground">
                    <Trans>Name</Trans>
                  </Label>
                  <Input
                    id="name"
                    name="name"
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t`Your name`}
                    className={fieldClass}
                  />
                </div>
              ) : null}
              <div className="w-full">
                <Label htmlFor="email" className="text-muted-foreground">
                  <Trans>Email</Trans>
                </Label>
                <Input
                  id="email"
                  name="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t`Your email address`}
                  type="email"
                  required
                  className={fieldClass}
                />
              </div>
              {mode !== "forgot" ? (
                <div className="mt-4 w-full">
                  <Label htmlFor={passwordFieldId} className="text-muted-foreground">
                    <Trans>Password</Trans>
                  </Label>
                  <div className="relative">
                    <Input
                      id={passwordFieldId}
                      name="password"
                      autoComplete={mode === "in" ? "current-password" : "new-password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={t`Password`}
                      type={showPassword ? "text" : "password"}
                      required
                      minLength={8}
                      className={`${fieldClass} pr-12`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setShowPassword((shown) => !shown)}
                      aria-label={showPassword ? t`Hide password` : t`Show password`}
                      aria-pressed={showPassword}
                      className="absolute inset-y-0 right-2 my-auto text-muted-foreground"
                    >
                      {showPassword ? <EyeOff /> : <Eye />}
                    </Button>
                  </div>
                  {mode === "in" && reset?.passwordReset ? (
                    <div className="mt-2 text-right text-sm">
                      <Link to="/forgot-password" className="font-medium text-foreground">
                        <Trans>Forgot password?</Trans>
                      </Link>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {error ? (
                <p role="alert" className="mt-3 w-full text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <Button type="submit" size="lg" disabled={pending} className={submitClass}>
                {pending ? (
                  <Trans>Working…</Trans>
                ) : mode === "in" ? (
                  <Trans>Continue with email</Trans>
                ) : mode === "forgot" ? (
                  <Trans>Send reset link</Trans>
                ) : (
                  <Trans>Create account</Trans>
                )}
              </Button>
              {reset.sso && mode !== "forgot" ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  disabled={pending}
                  className="mt-3 text-muted-foreground"
                  onClick={() => void signInWithSso()}
                >
                  <Trans>Continue with {reset.sso.name}</Trans>
                </Button>
              ) : null}
              <p className="mt-8 text-muted-foreground">
                {mode === "in" ? (
                  <>
                    <Trans>Don’t have an account?</Trans>{" "}
                    <Link to="/sign-up" className="font-medium text-foreground">
                      <Trans>Sign up</Trans>
                    </Link>
                  </>
                ) : mode === "up" ? (
                  <>
                    <Trans>Already have an account?</Trans>{" "}
                    <Link to="/sign-in" className="font-medium text-foreground">
                      <Trans>Sign in</Trans>
                    </Link>
                  </>
                ) : (
                  <Link to="/sign-in" className="font-medium text-foreground">
                    <Trans>Back to sign in</Trans>
                  </Link>
                )}
              </p>
            </>
          ) : null}
        </>
      )}
    </AuthFrame>
  );
}

/** Better Auth answers a password sign-in for an enrolled account with this instead of a session. */
function needsSecondFactor(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { twoFactorRedirect?: unknown }).twoFactorRedirect === true
  );
}

export function PasswordResetPage() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(
    params.get("error") || !params.get("token") ? t`This reset link is invalid or expired` : null,
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const token = params.get("token");
    if (!token) return;
    if (password !== confirmation) {
      setError(t`Passwords do not match`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        setError(authErrorText(result.error, t`Could not reset password`));
        return;
      }
      setComplete(true);
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthFrame onSubmit={submit} title={<Trans>Choose a new password</Trans>}>
      {complete ? (
        <div role="status" className="w-full text-center">
          <p className="text-lg">
            <Trans>Password updated</Trans>
          </p>
          <Link to="/sign-in" className="mt-6 inline-block font-medium">
            <Trans>Sign in</Trans>
          </Link>
        </div>
      ) : (
        <>
          <PasswordField
            id="new-password"
            label={t`New password`}
            value={password}
            onChange={setPassword}
          />
          <PasswordField
            id="confirm-password"
            label={t`Confirm password`}
            value={confirmation}
            onChange={setConfirmation}
            className="mt-4"
          />
          {error ? (
            <p role="alert" className="mt-3 w-full text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            disabled={pending || !params.get("token")}
            className={submitClass}
          >
            {pending ? <Trans>Working…</Trans> : <Trans>Reset password</Trans>}
          </Button>
          <Link to="/sign-in" className="mt-6 font-medium">
            <Trans>Back to sign in</Trans>
          </Link>
        </>
      )}
    </AuthFrame>
  );
}

export function AuthFrame({
  title,
  onSubmit,
  children,
}: {
  title: React.ReactNode;
  onSubmit: (event: React.FormEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full items-center justify-center bg-background px-6 py-16 text-foreground">
      <form onSubmit={onSubmit} className="flex w-[460px] flex-col items-center">
        <BrandLogo className="size-[74px]">
          <div className="flex h-[74px] w-[74px] items-center justify-center gap-[11px] rounded-full bg-muted">
            <span className="h-5 w-[9px] rounded-full bg-primary" />
            <span className="h-5 w-[9px] rounded-full bg-primary" />
          </div>
        </BrandLogo>
        <h1 aria-live="polite" className="mb-9 mt-7 text-4xl font-medium tracking-tight">
          {title}
        </h1>
        {children}
      </form>
    </div>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  className = "",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={`w-full ${className}`}>
      <Label htmlFor={id} className="text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        name={id}
        autoComplete="new-password"
        type="password"
        required
        minLength={8}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={fieldClass}
      />
    </div>
  );
}
