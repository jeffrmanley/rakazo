# Test accounts for live acceptance checks

## Problem

Acceptance checks against a running deployment need a signed-in user who is not the deployment
owner. A real deployment usually limits sign-ups to an allowlist, and once one person has an
account every further sign-up needs email delivery, so a checker cannot simply sign up. The
operator should not have to open sign-ups or set up a mailbox just to run the checks.

## Interface

Run inside the api container (it needs `DATABASE_URL`; nothing here is reachable over HTTP):

```
pnpm --silent --filter @rakazo/api test-account create        # password on stdin, one line
pnpm --silent --filter @rakazo/api test-account list
pnpm --silent --filter @rakazo/api test-account delete <email>
pnpm --silent --filter @rakazo/api test-account delete --all
```

- `create` reads a password (16 to 128 printable ASCII characters, no spaces) from stdin and
  prints one JSON line, `{"email":"live-test-<12 hex>@live-test.invalid","spaceId":"…"}`. It first
  deletes test accounts older than 24 hours (noted on stderr), and refuses to run before the
  deployment has an owner or when password sign-in is disabled.
- `list` prints one line per test account, `<email> <created ISO time>`, at most 100.
- `delete` removes the account through the API's own `POST /api/auth/delete-user`, so the bots,
  the personal space and the sessions go exactly as when a person deletes their account. It sets
  a new random password first, signs in, then deletes. Deleting an absent account succeeds.
  `--all` repeats until none are left. Each deletion is a sign-in, so production rate limiting
  allows about 10 per 15 minutes.
- Exit codes: 0 done, 1 failed, 2 usage error or refused input. An unexpected error prints only
  `failed: internal error (error_id=…, <error name and code>)`.

## Acceptance criteria

1. A created account has a verified email and a password login, owns a new personal space, and is
   not the deployment owner. The sign-up policy and the owner are unchanged.
2. It can sign in while the allowlist excludes it and no email delivery is configured.
3. Only addresses matching `live-test-<12 lowercase hex>@live-test.invalid` can be created or
   deleted. Any other address is refused before the database is touched.
4. `create` refuses a missing, short, over-long or non-ASCII password, a deployment without an
   owner, and a deployment with password sign-in disabled. If setting up the space fails, the
   half-made account is removed.
5. After `delete`, the user, its sessions, its personal organization and space, and its bots are
   gone. Audit events stay (the chain is append-only).
6. The password is never printed or logged.
7. Nobody can sign up, sign in with OIDC, or change their email into the reserved domain, and a
   test account never counts as a person when the app decides whether the first account still
   needs email delivery.
8. Test accounts older than 24 hours are deleted by the next `create`.

## Security

- The `.invalid` top-level domain is reserved (RFC 2606), so these addresses cannot receive mail.
  The app also refuses the `live-test.invalid` domain at sign-up, OIDC sign-in and email change, so
  no person can hold such an account. Restricting `delete` to that pattern means the command
  cannot remove a real account, and `create` never reuses an existing address.
- The live checks turn Playwright traces and videos off, since they would record the password.
- Access to the command is access to the api container, which already holds the database
  credentials. It adds no HTTP route.
- A test account gets a member's rights in its own space only. Every owner-only check still
  refuses it, which is what the live checks verify.
