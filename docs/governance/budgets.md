# Budgets, concurrency and delegation limits

Fork extension, milestone M2c. Off by default; `EXT_BUDGETS=1` turns it on for the API and the
worker. With the flag off nothing changes: no run is gated, no lineage or notice rows are written,
the `/api/v1/budgets` routes are not mounted (404), and the settings UI shows nothing.

## Behaviour

**Budget day.** The UTC calendar day. Spend is the sum of `usage_records.costUsd` recorded today
for a bot (`botId`) or a space (`spaceId`); calls without a price count as zero. Thresholds are
compared in micro-dollars, so float sums cannot flip them.

**Caps.**

| Cap | Default | Set by |
| --- | --- | --- |
| Bot, profile `assistant` | `EXT_BUDGET_DEFAULT_DAILY_USD` ($3) | bot owner or space owner |
| Bot, profile `worker` | $15 | bot owner or space owner |
| Bot, profile `swarm` | $40 | space owner |
| Bot, profile `custom` | the amount given ($0.01 to $10,000) | space owner |
| Space | `EXT_BUDGET_SPACE_DAILY_USD` ($50), or a custom amount | space owner |

**Who may change what.** A bot's owner who is not a space owner may only keep the bot at or
below the deployment defaults: the `assistant` or `worker` profile, and concurrency, delegation
depth and fan-out no higher than the defaults (or the default itself). The `swarm` profile, custom
amounts, premium, and any limit above its default need a space owner. The API refuses anything
else with 403; the settings show those choices disabled.

A **top-up** raises today's cap for one bot or for the space by an amount ($0.01 to $10,000). It
is stored against the UTC day and expires when that day ends. Only space owners can top up.

**At 80%** of a cap the owner is notified once per cap per UTC day: the bot's owner for a bot cap
(the space owner if the bot's owner left the space), the space owner for the space cap. The notice
goes to chat through the bot's home messaging identity when one of the recipient's bots in the
space has a linked chat app; otherwise it is an unread note in their bot's thread. Crossing 80%
and 100% in one call sends one notice.

**At 100%** of either cap:

- A run that is claimed is refused before it does anything: a `budget.block` audit event is
  written (detail: scope, spend, cap, trigger), and the run completes with a short notice to the
  requester in the same chat ("This bot reached its daily budget. A space owner can top it up in
  settings.", or the space variant). Messaging runs mirror that notice back to Slack or Teams like
  any reply; bot-to-bot requests get it back as a status. Background runs (routines, webhooks)
  post nothing.
- **Mid-run:** the model call that crossed the cap finishes and is accounted, and what it produced
  (a final answer included) is delivered; the run then halts before any further tool call or model
  call and completes with "Stopped: daily budget reached." after that answer. A `budget.block`
  event with `reason: "halted"` is written.
- **Background model calls** stop too: the team-chat ambient judge stays silent without calling
  the model, and history compaction is deferred until a later run (its cursor does not move).
- **Routines** that fire over budget are skipped: the schedule advances to the next occurrence
  (no retry) and a `budget.block` event with `reason: "routine_skipped"` records why.

**Monthly alert.** When a space has spent $400 in the UTC calendar month, the space owner is
notified once that month, through the same channel as the 80% notice.

**Premium models.** Model ids containing `fable` or `mythos` (the most expensive tier) may be used
only by bots marked premium. Choosing one for a non-premium bot (bot model, routine model, or
duplicating a bot that uses one) is refused by the API. At run time the rule is applied to the
model the run actually selected (the bot's model, else the connection, space or deployment
default): such a run is refused with a notice and a `budget.block` event. Premium backup models are
left out of a non-premium bot's fallbacks, and a premium `model_id` asked for by `run_subagent` is
returned to the model as the tool's error. Only a space owner can mark a bot premium.

**Delegation limits.** A delegation is `message_bot`, `spawn_bot` with a first task,
`handoff_to_bot`, `run_subagent` or `cloud_agent_launch`. Depth is the number of delegations
between a run and the run a person started; fan-out is the number of delegations one run started.
A delegation that would exceed `maxSpawnDepth` or `maxSpawnFanout` is returned to the model as an
ordinary tool error that says what happened and what to do instead, and nothing is started.
`spawn_bot` without a task is checked against the limits but, since it starts no run, is not
counted toward them.

**Concurrency.** Runs of one bot (chat, routines, delegated) above `maxConcurrentRuns` stay
`queued` instead of starting and retry every two seconds until a slot frees; the job reconciler is
the backstop. A freed slot goes to the run that has waited longest (oldest first), so a stream of
new chat runs cannot starve an older routine run; a newer run that finds the slot free yields and
wakes the oldest waiter. A waiter that has not retried for 15 seconds is skipped, so a stalled run
cannot block its bot. A run that can no longer start (finished or cancelled) stops retrying. Runs
whose lease has expired (a dead worker) do not hold a slot. Bots on a shared
Team computer were already limited to one run at a time by the computer lease; the cap matters for
bots on their own computer.

**Policy changes are human-only.** Budgets, premium and limits change only through the
authenticated API below. There is no tool the model can call to read or change them (a unit test
asserts no tool name or argument refers to budgets, premium, top-ups or limits).

## Settings

- Bot settings, for the bot's owner and space owners: today's spend against the cap, the profile
  select and custom amount, "Premium models" (space owners), "Top up today" (space owners, once
  the bot is at 80%), and a collapsed "Limits" disclosure for runs at once, delegation depth and
  delegations per run (blank uses the deployment default). For a bot owner who is not a space
  owner, `swarm` and `custom` are disabled and the limits stop at the defaults.
- Settings, Budget section, for every member: today's space spend against the cap; space owners
  can set the daily cap (blank uses the default) and top up today.
- The settings are web and desktop only; mobile shows no budget UI.

## API

Session cookie or bearer token; `cache-control: no-store`. The space is always the authenticated
actor's: a `spaceId` in the query or body is ignored, and `x-rakazo-space-id` only selects among
the caller's own memberships (401 otherwise). A bot in another space, or one the caller may not
edit, answers 404. Validation errors answer 400, permission errors 403, unexpected errors 500 with
an `error_id`. Every change is written with a `policy.change` audit event in the same transaction;
if that write fails, the change is not made.

| Method and path | Body | Who |
| --- | --- | --- |
| `GET /api/v1/budgets/space` | | any member |
| `PUT /api/v1/budgets/space` | `{ "dailyUsd": number \| null }` | space owner |
| `POST /api/v1/budgets/space/top-up` | `{ "amountUsd": number }` | space owner |
| `GET /api/v1/budgets/bots/:botId` | | bot owner, space owner |
| `PUT /api/v1/budgets/bots/:botId` | any of `profile`, `customDailyUsd`, `premium`, `maxConcurrentRuns`, `maxSpawnDepth`, `maxSpawnFanout` | bot owner (lowering only, see above), space owner |
| `POST /api/v1/budgets/bots/:botId/top-up` | `{ "amountUsd": number }` | space owner |

Limits are whole numbers from 0 to 50, or `null` for the default. `customDailyUsd` implies the
`custom` profile. The bot view returns today's bot and space spend, caps, top-ups and levels
(`ok`, `warn`, `blocked`), the stored settings, the effective limits, the defaults, and what the
caller may do (`canRaise`, `canSetPremium`, `canTopUp`).

## Deployment notes

- Migration `20261015120000_ext_budgets` builds two indexes on `usage_records`. Prisma runs
  migrations in a transaction, so they cannot use `CREATE INDEX CONCURRENTLY`; the build locks
  writes to `usage_records` (model usage accounting) until it finishes. On a large table, apply
  the migration in a quiet window.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `EXT_BUDGETS` | `0` | `1` turns the module on (API and worker). |
| `EXT_BUDGET_DEFAULT_DAILY_USD` | `3` | Daily cap of the `assistant` profile. |
| `EXT_BUDGET_SPACE_DAILY_USD` | `50` | Default daily cap of a space. |
| `EXT_MAX_CONCURRENT_RUNS_PER_BOT` | `2` | Default runs at once per bot (at least 1 is enforced). |
| `EXT_MAX_SPAWN_DEPTH` | `2` | Default delegation depth. |
| `EXT_MAX_SPAWN_FANOUT` | `5` | Default delegations per run. |

## Design

Where enforcement hooks in (`packages/adapters/src/ext-budget-guard.ts`), each a single call in
the executor:

1. **Run claim** (`claimRunWithinBotLimit`): the lease update of `continueRun` runs inside a
   transaction that first takes `pg_advisory_xact_lock(hashtextextended('ext-bot-runs:' || botId))`
   and counts the bot's other `leased`/`running` runs with an unexpired lease. Over the cap the
   transaction claims nothing and a delayed `run.continue` job is queued. The lock serializes every
   claimer of one bot across worker processes, and the count and the claim commit together, so two
   workers cannot both take the last slot (the database test fails without the lock).
2. **After the claim** (`refuseRunOverBudget`): the daily caps are checked once the run holds its
   lease and attempt, so it can be finished through the normal `finalizeRun` path with its notice.
   Once the run's model is selected, `premiumModelGate` applies the premium rule to that model,
   its backups and its sub-agent model resolver (`refuseRunForModel` refuses the run).
3. **After each model call** (`budgetAfterModelCall`, from the usage hook that records the call's
   cost): sends due notices and, at 100%, aborts the run; the executor finishes it with the stop
   notice instead of a failure, and the tool wrapper refuses any tool call after the halt.
4. **Delegation** (`delegationLimitedTools` around the executor's tool function, and
   `admitDelegation` on the runtime request for `run_subagent`, which Pi runs itself): checks depth
   and fan-out one call at a time per run. Runs created by a delegation are recorded in
   `ext_run_spawns` inside the transaction that creates them (`recordDelegatedRun` in
   `bot-messages.ts`, `child-bots.ts` and `group-handoff.ts`), so a child's depth is known before
   it can be claimed.

Routines are checked when they fire (`skipRoutineOverBudget` in `wakeRoutine`).

Tables (migration `20261015120000_ext_budgets`), FK-free like the audit tables so deleting a bot
or space never cascades into spend history: `ext_bot_budgets`, `ext_space_budgets`,
`ext_budget_topups`, `ext_budget_notices` (unique `kind, subjectId, period`: the cross-worker
de-duplication), `ext_run_spawns` and `ext_run_slot_waits` (runs waiting for a slot; migration
`20261016120000_ext_run_slot_waits`). Two indexes on `usage_records` (`spaceId, createdAt` and
`spaceId, botId, createdAt`) keep today's sums cheap.

## Limitations

- Spend is known after a call is priced, so the call that crosses a cap always completes and can
  overshoot the cap by its own cost. Concurrent runs of one bot can each finish one call past the
  cap. Calls without a provider price count as zero.
- `budget.block` and `policy.change` events are written only when `EXT_AUDIT_LOG=1`; with the
  audit log off, blocks are logged and changes are not recorded.
- A queued run waits by polling (every two seconds); it is woken early only when a newer run
  yields the slot to it, not when a running run finishes.
- Notices to a person with no bot in the space are not delivered (and are retried at the next
  crossing).
- Auto-review judge calls are counted in spend but never halt a run themselves.
