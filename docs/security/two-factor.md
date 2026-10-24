# Two-factor sign-in (authenticator app)

Password sign-in can ask for a second factor: a 6-digit code from an authenticator app (TOTP,
30-second steps, one step of clock drift accepted either way), or one of ten single-use backup
codes. It is built on Better Auth's `two-factor` plugin; the policy around it lives in
`packages/auth/src/two-factor.ts`.

## Turning it on and off

- **Settings → Security → Two-factor authentication → Turn on.** Enter the password, scan the QR
  code (or open "Can't scan it?" and type the key), then enter the code the app shows. The ten
  backup codes appear once, after that code is accepted. Two-factor is on only from then.
- **Turn off** needs the password and a current authenticator code or a backup code.
- **Sign-in:** after the password, the app asks for the code. "Use a backup code" switches to a
  backup code; each one works once. "Trust this device for 30 days" skips the code on that browser
  until it expires or two-factor is turned off.

The desktop app shows the web UI, so it works the same. The mobile app cannot enter a code yet:
a two-factor account's mobile sign-in answers "Two-factor sign-in isn't supported in this app
version yet. Sign in on the web."

## Who must enrol

| Account | Required | Until enrolled |
| --- | --- | --- |
| The deployment owner (`deployment_settings.ownerUserId`) | Always | Every signed-in page shows a banner with **Turn on**. The session keeps working, so turning the feature on can never lock the owner out. |
| Everyone else, when the owner turns on **Settings → Security → Require two-factor sign-in for every account** (`require2faForAll`, default off) | Yes | The web app shows only the enrolment screen, and the API refuses `/rpc` and `/api/v1` for that account. This applies to sessions that already exist, not only the next sign-in. |
| Test accounts (`…@live-test.invalid`, see `docs/test-accounts.md`) and messaging identities | Never | They can still turn it on themselves; don't, or `test-account delete` can no longer sign in to remove them. |
| Accounts without a password (OIDC only) | Never | The second factor guards password sign-in; an SSO account's identity provider owns its MFA. OIDC sign-ins are never asked for a code, even on an account that also has a password. |

Only the owner can change `require2faForAll`. The API checks ownership again inside the write's
transaction, logs every refusal, and with `EXT_AUDIT_LOG=1` records each change as a
`policy.change` audit event.

## Limits

- A pending sign-in (password accepted, code not yet) lasts 5 minutes and accepts 5 codes. After
  that the password has to be entered again.
- 10 wrong codes in a row lock the account's second factor for 15 minutes.
- In production, Better Auth's limiter also caps `/two-factor/*` at 3 requests per 10 seconds per
  client address, on top of the 10-per-15-minutes limit on password sign-in.

## What is stored

- `two_factor.secret`: the TOTP key, encrypted by the plugin with XChaCha20-Poly1305 under a key
  derived from `BETTER_AUTH_SECRET`. The plugin has no hook to substitute another cipher.
- `two_factor.backupCodes`: HMAC-SHA-256 digests of the unused backup codes, keyed with
  `BETTER_AUTH_SECRET`; the codes themselves are never stored. A submitted code is digested
  before the plugin compares it, so a digest copied from the database does not work as a code.
- One `two_factor` row per user; a newer unconfirmed enrolment replaces an older one, and a
  confirmed key is never replaced. Trusted devices and pending sign-ins are rows in
  `verification`.

Changing `BETTER_AUTH_SECRET` makes every stored key and backup code unusable. Reset two-factor
for the affected accounts afterwards (below).

## Audit and logs

With `EXT_AUDIT_LOG=1`, `auth.2fa_enabled`, `auth.2fa_disabled` and `auth.2fa_failed` are appended
to the account's default space. Every failure is also logged as `two-factor verification failed`
with the user id, client address, the reason (for example `INVALID_CODE`) and an error id. No
code, key or backup code is ever logged or audited.

## Recovery

1. **Backup codes.** Sign in with one, then turn two-factor off and on again for a new key and
   new codes.
2. **Host reset.** Only the host operator can do this. In the api container, as the deploy user:

   ```sh
   pnpm exec tsx src/cli/reset-2fa.ts <email>
   ```

   It removes the account's key, backup codes, trusted devices and pending sign-ins, prints
   `reset: <email>` (or `not enrolled: <email>`), and with `EXT_AUDIT_LOG=1` records
   `auth.2fa_disabled` with the actor `system:reset-2fa`. Sessions stay. The owner sees the
   enrolment banner again at the next page load.

The reset has no HTTP route, no package script and no deploy-helper command, on purpose: an agent
or a stolen session can never remove the owner's second factor. Do not add one.
