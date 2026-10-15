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
- Tamper-evident audit log (`EXT_AUDIT_LOG`, see `docs/governance/audit-log.md`).
- Emergency stop for a bot, a space or the deployment, from the web app, the API, and Slack and
  Teams (`EXT_EMERGENCY_STOP`, see `docs/governance/emergency-stop.md`).
- Daily spend caps, run concurrency and delegation limits per bot and space (`EXT_BUDGETS`,
  see `docs/governance/budgets.md`).
- Approvals: risky tool calls wait for a listed approver, decided from the web card or
  Approve/Deny buttons in Slack and Teams, with expiry and audit (`EXT_APPROVALS`, see
  `docs/governance/approvals.md`).
- White-label branding: the deployment owner sets the name, short name, tagline and logo in
  Settings → Branding (stored in `deployment_settings`, served by public `/api/v1/brand`
  endpoints), with `PUBLIC_BRAND_*` as the fallback; emails, chat replies and default prompts
  follow it without a rebuild.
- A production compose stack end-to-end test (`infra/compose/e2e`).
- Red-team evals: a deterministic suite in which the offline model emulator plays a hostile,
  prompt-injected model against every governance control, `pnpm test:redteam` with a markdown
  report, and an opt-in live mode that measures whether a real model attempts a violation
  (`EXT_EVALS`, see `docs/governance/evals.md`).

## Files

Relative to upstream commit `2d666c4`.

### `(root)`

- `.env.example` (modified)
- `package.json` (modified)
- `pnpm-lock.yaml` (modified)

### `apps/api`

- `apps/api/package.json` (modified)
- `apps/api/src/app.ts` (modified)
- `apps/api/src/brand.test.ts` (added)
- `apps/api/src/brand.ts` (added)
- `apps/api/src/cli/audit-verify.ts` (added)
- `apps/api/src/env.test.ts` (modified)
- `apps/api/src/env.ts` (modified)
- `apps/api/src/ext-approvals.ts` (added)
- `apps/api/src/ext-audit.test.ts` (added)
- `apps/api/src/ext-audit.ts` (added)
- `apps/api/src/ext-budgets.test.ts` (added)
- `apps/api/src/ext-budgets.ts` (added)
- `apps/api/src/ext-emergency-stop.test.ts` (added)
- `apps/api/src/ext-emergency-stop.ts` (added)
- `apps/api/src/ext-modules.test.ts` (added)
- `apps/api/src/ext-modules.ts` (added)
- `apps/api/src/messaging-inbound.test.ts` (modified)
- `apps/api/src/messaging-inbound.ts` (modified)
- `apps/api/src/router-messaging.test.ts` (modified)
- `apps/api/src/router.ts` (modified)
- `apps/api/src/server-update.ts` (modified)
- `apps/api/src/team-chat-bridge.ts` (modified)
- `apps/api/src/team-chat-judge.test.ts` (modified)
- `apps/api/src/team-chat-judge.ts` (modified)
- `apps/api/src/team-chat-startup.test.ts` (modified)
- `apps/api/src/team-chat-startup.ts` (modified)

### `apps/mobile`

- `apps/mobile/lib/api.test.ts` (modified)
- `apps/mobile/lib/api.ts` (modified)

### `apps/web`

- `apps/web/e2e/branding.spec.ts` (added)
- `apps/web/e2e/helpers.ts` (modified)
- `apps/web/e2e/messaging-settings.spec.ts` (modified)
- `apps/web/e2e/stack-smoke.spec.ts` (added)
- `apps/web/public/site.webmanifest` (removed)
- `apps/web/src/brand-plugin.test.ts` (added)
- `apps/web/src/brand-plugin.ts` (added)
- `apps/web/src/components/BrandLogo.tsx` (added)
- `apps/web/src/lib/approvals.test.ts` (added)
- `apps/web/src/lib/approvals.ts` (added)
- `apps/web/src/lib/brand.test.ts` (added)
- `apps/web/src/lib/brand.ts` (added)
- `apps/web/src/lib/budgets.test.ts` (added)
- `apps/web/src/lib/budgets.ts` (added)
- `apps/web/src/lib/emergency-stop.test.ts` (added)
- `apps/web/src/lib/emergency-stop.ts` (added)
- `apps/web/src/lib/ext-modules.test.ts` (added)
- `apps/web/src/lib/ext-modules.ts` (added)
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
- `apps/web/src/main.tsx` (modified)
- `apps/web/src/pages/Auth.tsx` (modified)
- `apps/web/src/pages/BotContextMenu.tsx` (modified)
- `apps/web/src/pages/BrandingSettingsPanel.tsx` (added)
- `apps/web/src/pages/BudgetSettingsPanel.tsx` (added)
- `apps/web/src/pages/McpOAuthCallback.tsx` (modified)
- `apps/web/src/pages/MessagingSettingsOverlay.tsx` (modified)
- `apps/web/src/pages/ModelSettingsOverlay.tsx` (modified)
- `apps/web/src/pages/SettingsOverlay.tsx` (modified)
- `apps/web/src/pages/Shell.tsx` (modified)
- `apps/web/src/pages/Welcome.tsx` (modified)
- `apps/web/src/pages/shell/bot-approvals.test.tsx` (added)
- `apps/web/src/pages/shell/bot-approvals.tsx` (added)
- `apps/web/src/pages/shell/bot-budget.test.tsx` (added)
- `apps/web/src/pages/shell/bot-budget.tsx` (added)
- `apps/web/src/pages/shell/bot-panel.tsx` (modified)
- `apps/web/src/vite-env.d.ts` (modified)
- `apps/web/vite.config.ts` (modified)

### `apps/worker`

- `apps/worker/src/index.ts` (modified)

### `docs`

- `docs/governance/approvals.md` (added)
- `docs/governance/audit-log.md` (added)
- `docs/governance/budgets.md` (added)
- `docs/governance/emergency-stop.md` (added)
- `docs/governance/evals.md` (added)
- `docs/self-host.md` (modified)
- `docs/teams-adapter-spec.md` (added)

### `infra/compose`

- `infra/compose/docker-compose.images.yml` (modified)
- `infra/compose/docker-compose.prod.yml` (modified)
- `infra/compose/docker-compose.yml` (modified)
- `infra/compose/e2e/README.md` (added)
- `infra/compose/e2e/docker-compose.e2e.yml` (added)
- `infra/compose/e2e/echo-model.mjs` (added)
- `infra/compose/e2e/run.sh` (added)

### `packages/adapter-kit`

- `packages/adapter-kit/src/interfaces.ts` (modified)
- `packages/adapter-kit/src/types.ts` (modified)

### `packages/adapters`

- `packages/adapters/package.json` (modified)
- `packages/adapters/src/agent-connections.test.ts` (modified)
- `packages/adapters/src/agent-connections.ts` (modified)
- `packages/adapters/src/approval-ask.test.ts` (modified)
- `packages/adapters/src/approval-ask.ts` (modified)
- `packages/adapters/src/bot-messages.ts` (modified)
- `packages/adapters/src/chat-sdk-surface.ts` (modified)
- `packages/adapters/src/child-bots.ts` (modified)
- `packages/adapters/src/cloud-agent-poll.ts` (modified)
- `packages/adapters/src/cloud-agent.postgres.test.ts` (modified)
- `packages/adapters/src/compacted-context.test.ts` (added)
- `packages/adapters/src/compacted-context.ts` (added)
- `packages/adapters/src/executor-readonly-approval.test.ts` (modified)
- `packages/adapters/src/executor.ts` (modified)
- `packages/adapters/src/ext-approval-actions.test.ts` (added)
- `packages/adapters/src/ext-approval-card.test.ts` (added)
- `packages/adapters/src/ext-approval-card.ts` (added)
- `packages/adapters/src/ext-approvals.test.ts` (added)
- `packages/adapters/src/ext-approvals.ts` (added)
- `packages/adapters/src/ext-audit-tools.test.ts` (added)
- `packages/adapters/src/ext-audit-tools.ts` (added)
- `packages/adapters/src/ext-budget-guard.test.ts` (added)
- `packages/adapters/src/ext-budget-guard.ts` (added)
- `packages/adapters/src/ext-emergency-stop.test.ts` (added)
- `packages/adapters/src/ext-emergency-stop.ts` (added)
- `packages/adapters/src/favicon.test.ts` (modified)
- `packages/adapters/src/group-handoff.ts` (modified)
- `packages/adapters/src/history-compaction.test.ts` (modified)
- `packages/adapters/src/history-compaction.ts` (modified)
- `packages/adapters/src/index.ts` (modified)
- `packages/adapters/src/keyless-http-web.ts` (modified)
- `packages/adapters/src/mcp-oauth.test.ts` (modified)
- `packages/adapters/src/mcp-oauth.ts` (modified)
- `packages/adapters/src/messaging-card.ts` (added)
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
- `packages/adapters/src/pi-runtime-computer.test.ts` (modified)
- `packages/adapters/src/pi-runtime.ts` (modified)
- `packages/adapters/src/runtime-context.test.ts` (modified)
- `packages/adapters/src/runtime-context.ts` (modified)
- `packages/adapters/src/slack-commands.test.ts` (added)
- `packages/adapters/src/slack-emulator.ts` (added)
- `packages/adapters/src/team-chat-messaging.test.ts` (modified)
- `packages/adapters/src/team-chat-messaging.ts` (modified)
- `packages/adapters/src/teams-emulator.ts` (added)
- `packages/adapters/src/teams-messaging.test.ts` (added)
- `packages/adapters/src/web-ssrf.test.ts` (modified)
- `packages/adapters/src/web-ssrf.ts` (modified)

### `packages/auth`

- `packages/auth/src/account-security.ts` (modified)
- `packages/auth/src/escape-html.ts` (added)
- `packages/auth/src/index.test.ts` (modified)
- `packages/auth/src/index.ts` (modified)

### `packages/contracts`

- `packages/contracts/src/brand.ts` (added)
- `packages/contracts/src/domain.ts` (modified)
- `packages/contracts/src/index.test.ts` (modified)
- `packages/contracts/src/index.ts` (modified)
- `packages/contracts/src/rpc.ts` (modified)

### `packages/core`

- `packages/core/package.json` (modified)
- `packages/core/src/approval-effect-key.test.ts` (modified)
- `packages/core/src/approval-effect-key.ts` (modified)
- `packages/core/src/brand-logo.test.ts` (added)
- `packages/core/src/brand-logo.ts` (added)
- `packages/core/src/brand.test.ts` (added)
- `packages/core/src/brand.ts` (added)
- `packages/core/src/ext-approvals.test.ts` (added)
- `packages/core/src/ext-approvals.ts` (added)
- `packages/core/src/ext-budget.test.ts` (added)
- `packages/core/src/ext-budget.ts` (added)
- `packages/core/src/ext-emergency-stop.test.ts` (added)
- `packages/core/src/ext-emergency-stop.ts` (added)
- `packages/core/src/ext-env.test.ts` (added)
- `packages/core/src/ext-env.ts` (added)
- `packages/core/src/index.ts` (modified)
- `packages/core/src/self-update.test.ts` (modified)
- `packages/core/src/self-update.ts` (modified)

### `packages/db`

- `packages/db/prisma/migrations/20261011120000_ext_audit_log/migration.sql` (added)
- `packages/db/prisma/migrations/20261011120000_messaging_multi_identity/migration.sql` (added)
- `packages/db/prisma/migrations/20261015120000_ext_budgets/migration.sql` (added)
- `packages/db/prisma/migrations/20261015120000_ext_emergency_stop/migration.sql` (added)
- `packages/db/prisma/migrations/20261015120000_runtime_brand/migration.sql` (added)
- `packages/db/prisma/migrations/20261016120000_ext_run_slot_waits/migration.sql` (added)
- `packages/db/prisma/migrations/20261017120000_ext_approvals/migration.sql` (added)
- `packages/db/prisma/migrations/20261018120000_ext_approvals_cards/migration.sql` (added)
- `packages/db/prisma/schema.prisma` (modified)
- `packages/db/src/brand-settings.postgres.test.ts` (added)
- `packages/db/src/brand-settings.ts` (added)
- `packages/db/src/events.ts` (modified)
- `packages/db/src/ext-approvals.postgres.test.ts` (added)
- `packages/db/src/ext-approvals.ts` (added)
- `packages/db/src/ext-audit.postgres.test.ts` (added)
- `packages/db/src/ext-audit.test.ts` (added)
- `packages/db/src/ext-audit.ts` (added)
- `packages/db/src/ext-budgets.postgres.test.ts` (added)
- `packages/db/src/ext-budgets.ts` (added)
- `packages/db/src/ext-emergency-stop.postgres.test.ts` (added)
- `packages/db/src/ext-emergency-stop.test.ts` (added)
- `packages/db/src/ext-emergency-stop.ts` (added)
- `packages/db/src/index.ts` (modified)
- `packages/db/src/messages.test.ts` (modified)
- `packages/db/src/messages.ts` (modified)
- `packages/db/src/messaging-migration.test.ts` (modified)
- `packages/db/src/messaging.test.ts` (modified)
- `packages/db/src/messaging.ts` (modified)
- `packages/db/src/transaction-retry.ts` (modified)

### `packages/testkit`

- `packages/testkit/src/cli/evals.ts` (modified)
- `packages/testkit/src/cli/harness.ts` (modified)
- `packages/testkit/src/cli/redteam.ts` (added)
- `packages/testkit/src/evals/redteam-cases.test.ts` (added)
- `packages/testkit/src/evals/redteam-cases.ts` (added)
- `packages/testkit/src/evals/redteam-cli.test.ts` (added)
- `packages/testkit/src/ext-approvals.postgres.test.ts` (added)
- `packages/testkit/src/ext-audit-log.postgres.test.ts` (added)
- `packages/testkit/src/ext-budgets.postgres.test.ts` (added)
- `packages/testkit/src/ext-emergency-stop.postgres.test.ts` (added)
- `packages/testkit/src/ext-redteam.postgres.test.ts` (added)
- `packages/testkit/src/messaging-multi-identity.test.ts` (added)
- `packages/testkit/src/model-emulator.test.ts` (modified)
- `packages/testkit/src/model-emulator.ts` (modified)
- `packages/testkit/src/teams-team-chat.test.ts` (added)
