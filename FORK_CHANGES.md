# Changes in this fork

This repository is a fork of [Rakazo](https://github.com/elie222/rakazo), licensed under the
Apache License 2.0 (see `LICENSE`). Section 4(b) of that license asks a modified work to carry
prominent notices stating that files were changed. This file is that notice: it lists every
file the fork added, modified or removed relative to the upstream commit it branched from.

The product name of this deployment is configured with `PUBLIC_BRAND_NAME` (see
`docs/self-host.md`, "White-label branding"). The fork does not use the Rakazo name as a
product name; package names, environment variables and internal identifiers keep their
upstream names, and the Apache-2.0 credit in Settings links back to the upstream repository.

## What changed

- Microsoft Teams messaging adapter (1:1 chats, then group chats and channels on the
  provider-neutral team-chat path).
- Bot replies rendered as Markdown in chat apps (Slack mrkdwn, Teams Markdown).
- One agent linked from several chat apps, with a per-bot home identity for proactive messages.
- The Messaging settings overlay shows the server's reason when a request is refused.
- White-label branding through `PUBLIC_BRAND_*`, with this notice and the Settings credit.
- Emergency stop for a bot, a space or the deployment (`EXT_EMERGENCY_STOP`, see
  `docs/governance/emergency-stop.md`).
- Daily spend caps, run concurrency and delegation limits per bot and space (`EXT_BUDGETS`,
  see `docs/governance/budgets.md`).

## Files

Relative to upstream commit `2d666c4`.

### `(root)`

- `.env.example` (modified)
- `pnpm-lock.yaml` (modified)

### `apps/api`

- `apps/api/src/app.ts` (modified)
- `apps/api/src/env.test.ts` (modified)
- `apps/api/src/env.ts` (modified)
- `apps/api/src/ext-emergency-stop.test.ts` (added)
- `apps/api/src/ext-emergency-stop.ts` (added)
- `apps/api/src/ext-budgets.test.ts` (added)
- `apps/api/src/ext-budgets.ts` (added)
- `apps/api/src/messaging-inbound.test.ts` (modified)
- `apps/api/src/messaging-inbound.ts` (modified)
- `apps/api/src/router-messaging.test.ts` (modified)
- `apps/api/src/router.ts` (modified)
- `apps/api/src/team-chat-bridge.ts` (modified)
- `apps/api/src/team-chat-startup.test.ts` (modified)
- `apps/api/src/team-chat-startup.ts` (modified)

### `apps/mobile`

- `apps/mobile/lib/api.test.ts` (modified)
- `apps/mobile/lib/api.ts` (modified)

### `apps/web`

- `apps/web/e2e/branding.spec.ts` (added)
- `apps/web/e2e/helpers.ts` (modified)
- `apps/web/e2e/messaging-settings.spec.ts` (modified)
- `apps/web/public/site.webmanifest` (removed)
- `apps/web/src/brand-plugin.test.ts` (added)
- `apps/web/src/brand-plugin.ts` (added)
- `apps/web/src/lib/brand.ts` (added)
- `apps/web/src/lib/emergency-stop.test.ts` (added)
- `apps/web/src/lib/emergency-stop.ts` (added)
- `apps/web/src/lib/budgets.test.ts` (added)
- `apps/web/src/lib/budgets.ts` (added)
- `apps/web/src/lib/messaging.test.ts` (added)
- `apps/web/src/lib/messaging.ts` (modified)
- `apps/web/src/lib/rpc-errors.test.ts` (added)
- `apps/web/src/lib/rpc-errors.ts` (added)
- `apps/web/src/locales/de/messages.po` (modified)
- `apps/web/src/locales/en/messages.po` (modified)
- `apps/web/src/locales/es/messages.po` (modified)
- `apps/web/src/locales/fr/messages.po` (modified)
- `apps/web/src/locales/hi/messages.po` (modified)
- `apps/web/src/locales/ko/messages.po` (modified)
- `apps/web/src/locales/pt-BR/messages.po` (modified)
- `apps/web/src/locales/ru/messages.po` (modified)
- `apps/web/src/locales/tr/messages.po` (modified)
- `apps/web/src/locales/zh-CN/messages.po` (modified)
- `apps/web/src/pages/AccountSettingsOverlay.tsx` (modified)
- `apps/web/src/pages/Auth.tsx` (modified)
- `apps/web/src/pages/BotContextMenu.tsx` (modified)
- `apps/web/src/pages/McpOAuthCallback.tsx` (modified)
- `apps/web/src/pages/MessagingSettingsOverlay.tsx` (modified)
- `apps/web/src/pages/ModelSettingsOverlay.tsx` (modified)
- `apps/web/src/pages/Shell.tsx` (modified)
- `apps/web/src/pages/BudgetSettingsPanel.tsx` (added)
- `apps/web/src/pages/SettingsOverlay.tsx` (modified)
- `apps/web/src/pages/Welcome.tsx` (modified)
- `apps/web/src/pages/shell/bot-budget.test.tsx` (added)
- `apps/web/src/pages/shell/bot-budget.tsx` (added)
- `apps/web/src/pages/shell/bot-panel.tsx` (modified)
- `apps/web/src/vite-env.d.ts` (modified)
- `apps/web/vite.config.ts` (modified)

### `apps/worker`

- `apps/worker/src/index.ts` (modified)

### `docs/governance`

- `docs/governance/emergency-stop.md` (added)
### `docs/governance/budgets.md`

- `docs/governance/budgets.md` (added)

### `docs/self-host.md`

- `docs/self-host.md` (modified)

### `docs/teams-adapter-spec.md`

- `docs/teams-adapter-spec.md` (added)

### `packages/adapter-kit`

- `packages/adapter-kit/src/interfaces.ts` (modified)
- `packages/adapter-kit/src/types.ts` (modified)

### `packages/adapters`

- `packages/adapters/package.json` (modified)
- `packages/adapters/src/agent-connections.test.ts` (modified)
- `packages/adapters/src/agent-connections.ts` (modified)
- `packages/adapters/src/bot-messages.ts` (modified)
- `packages/adapters/src/chat-sdk-surface.ts` (modified)
- `packages/adapters/src/cloud-agent-poll.ts` (modified)
- `packages/adapters/src/cloud-agent.postgres.test.ts` (modified)
- `packages/adapters/src/executor.ts` (modified)
- `packages/adapters/src/executor-readonly-approval.test.ts` (modified)
- `packages/adapters/src/ext-emergency-stop.test.ts` (added)
- `packages/adapters/src/ext-emergency-stop.ts` (added)
- `packages/adapters/src/child-bots.ts` (modified)
- `packages/adapters/src/ext-budget-guard.test.ts` (added)
- `packages/adapters/src/ext-budget-guard.ts` (added)
- `packages/adapters/src/group-handoff.ts` (modified)
- `packages/adapters/src/index.ts` (modified)
- `packages/adapters/src/messaging-context.ts` (modified)
- `packages/adapters/src/messaging-delivery.test.ts` (modified)
- `packages/adapters/src/messaging-delivery.ts` (modified)
- `packages/adapters/src/messaging-formatting.test.ts` (added)
- `packages/adapters/src/messaging-platforms.test.ts` (modified)
- `packages/adapters/src/messaging-platforms.ts` (modified)
- `packages/adapters/src/messaging-team-chat-emulator.test.ts` (modified)
- `packages/adapters/src/messaging-team-chat-emulator.ts` (modified)
- `packages/adapters/src/pi-catalog-availability.ts` (modified)
- `packages/adapters/src/pi-models.test.ts` (modified)
- `packages/adapters/src/pi-models.ts` (modified)
- `packages/adapters/src/pi-oauth.ts` (modified)
- `packages/adapters/src/pi-runtime.ts` (modified)
- `packages/adapters/src/slack-commands.test.ts` (added)
- `packages/adapters/src/slack-emulator.ts` (added)
- `packages/adapters/src/team-chat-messaging.test.ts` (modified)
- `packages/adapters/src/team-chat-messaging.ts` (modified)
- `packages/adapters/src/teams-emulator.ts` (added)
- `packages/adapters/src/teams-messaging.test.ts` (added)

### `packages/auth`

- `packages/auth/src/account-security.ts` (modified)
- `packages/auth/src/escape-html.ts` (added)
- `packages/auth/src/index.test.ts` (modified)
- `packages/auth/src/index.ts` (modified)

### `packages/contracts`

- `packages/contracts/src/domain.ts` (modified)
- `packages/contracts/src/index.test.ts` (modified)
- `packages/contracts/src/rpc.ts` (modified)

### `packages/core`

- `packages/core/src/brand.test.ts` (added)
- `packages/core/src/brand.ts` (added)
- `packages/core/src/ext-emergency-stop.test.ts` (added)
- `packages/core/src/ext-emergency-stop.ts` (added)
- `packages/core/src/ext-budget.test.ts` (added)
- `packages/core/src/ext-budget.ts` (added)
- `packages/core/src/ext-env.ts` (added)
- `packages/core/src/index.ts` (modified)

### `packages/db`

- `packages/db/prisma/migrations/20261011120000_messaging_multi_identity/migration.sql` (added)
- `packages/db/prisma/migrations/20261015120000_ext_emergency_stop/migration.sql` (added)
- `packages/db/prisma/schema.prisma` (modified)
- `packages/db/src/events.ts` (modified)
- `packages/db/src/ext-emergency-stop.postgres.test.ts` (added)
- `packages/db/src/ext-emergency-stop.test.ts` (added)
- `packages/db/src/ext-emergency-stop.ts` (added)
- `packages/db/prisma/migrations/20261015120000_ext_budgets/migration.sql` (added)
- `packages/db/src/ext-budgets.postgres.test.ts` (added)
- `packages/db/src/ext-budgets.ts` (added)
- `packages/db/src/index.ts` (modified)
- `packages/db/src/messaging-migration.test.ts` (modified)
- `packages/db/src/messaging.test.ts` (modified)
- `packages/db/src/messaging.ts` (modified)

### `packages/testkit`

- `packages/testkit/src/cli/evals.ts` (modified)
- `packages/testkit/src/cli/harness.ts` (modified)
- `packages/testkit/src/ext-emergency-stop.postgres.test.ts` (added)
- `packages/testkit/src/ext-budgets.postgres.test.ts` (added)
- `packages/testkit/src/messaging-multi-identity.test.ts` (added)
- `packages/testkit/src/teams-team-chat.test.ts` (added)
