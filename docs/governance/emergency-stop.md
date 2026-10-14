# Emergency stop

Fork extension (governance milestone M2b). Off by default; `EXT_EMERGENCY_STOP=1` turns it on.
Set it for the API and the worker alike. With the flag off nothing changes: the control routes
are not mounted (404), `/stop` in a chat is ordinary text, the web app shows no new controls and
no run, routine or delivery path reads the stop table.

## Behaviour

A stop halts one bot, every bot of one space, or every bot of the deployment. Within five
seconds of the request:

- Queued, leased and waiting runs in the scope are cancelled (`run.cancelled` per run).
- A running run's in-flight model call is aborted and the run ends `cancelled`.
- Queued tool calls are dropped. A tool call already executing is allowed to finish; its
  result is recorded (the audit log's `tool.result`), then the run halts before the next model
  call. Nothing new starts.
- Due routines do not start. A recurring routine skips the occurrence (the next one is
  scheduled); a one-shot routine stays due and fires once the bot is resumed.
- The bot's computer is paused, not destroyed: background shell work left by the scope's runs is
  terminated, and the regular idle sleep checkpoints the workspace and stops the sandbox a few
  seconds later, once no run holds it. A computer shared with a bot that is still running stays
  up.
- New chat messages to a stopped bot get `Paused by <name> at <YYYY-MM-DD HH:MM> UTC` and start
  no run. In a team room the bot answers mentions and direct messages that way and ignores
  ambient talk; on the personal line a stopped bot sits out group conversations silently.
- Outbound sends from a stopped bot are dropped, not queued: chat mirrors of its replies are not
  written, pending outbox rows for its messages are marked failed, and team-chat replies are
  recorded with the handle `suppressed:emergency-stop` instead of being posted.

The checks are deterministic code: at run start (before the run is leased), before the model
call, around every tool call (before it, and again after it before the result returns to the
model), before every chat send, and in the routine wake. A stop stays in force across API and
worker restarts until it is resumed.

## Propagation

Stops are rows in `ext_control_stops` (migration `20261015120000_ext_emergency_stop`): `scope`,
`spaceId` (null for global), `botId` (bot stops only), `reason`, `stoppedBy`, `stoppedAt`,
`resumedBy`, `resumedAt`. A row with `resumedAt` null is active; a resume stamps it and the row
stays as history. A check constraint enforces the scope shape.

Each process reads active stops through a cache keyed by space with a one second TTL (one query
per space per second at most, `WHERE resumedAt IS NULL AND (scope = 'global' OR spaceId = $1)`).
The process that writes a stop or resume drops its cache at once. Every live run watches the
state once a second, so a stop written by the API reaches a run in the worker within about two
seconds. The API also cancels the scope's runs that are not executing in the same request; the
worker's guard halts the executing ones. No LISTEN/NOTIFY channel is involved, so a missed
notification cannot leave a run going.

If the stop state cannot be read, the guards fail closed: the run does not start, the model is
not called and the tool does not execute. The background watcher logs the error and retries on
its next tick.

## API

Session cookie or bearer token, like the rest of the API. The space is always the session's
(`x-rakazo-space-id` selects among the caller's own memberships); a `spaceId` in the body or the
query is ignored.

| Route | Body | Result |
| --- | --- | --- |
| `POST /api/v1/control/stop` | `{ "scope": "bot" \| "space" \| "global", "botId"?: string, "reason": string }` | `{ stop, error_id? }` |
| `POST /api/v1/control/resume` | same shape | `{ resumed: number }` |
| `GET /api/v1/control/state` | | `{ canControl, canControlGlobal, stops }` |

- `botId` is required for `bot`; `reason` is required (at most 500 characters).
- Authorization is default deny and checked in the service: `bot` and `space` need the owner
  role in the session space; `global` needs the deployment owner (`DeploymentSettings.ownerUserId`).
  Being the deployment owner does not make someone the owner of a space they only belong to.
- A bot from another space is `404 Not found`, exactly like a bot that does not exist. Every
  refusal (401, 403, 404) is logged server-side with the user and space ids.
- Stopping an already stopped target returns the existing stop. Resume lifts exactly the named
  target: resuming a space does not lift a bot stop inside it, and resuming a bot does not lift
  its space's stop. `resumed: 0` means nothing was stopped at that target.
- `state` lists the active global stops and the session space's own, never another space's.

## Chat commands

From Slack or Teams, in a DM or a channel (after a mention of the bot is fine):

| Command | Effect |
| --- | --- |
| `/stop` | Stop every bot in the sender's space. |
| `/stop <bot>` | Stop that bot (name matched case-insensitively within the space). |
| `/resume <bot>` | Resume that bot. |
| `/resume` | Resume the space. |

The sender must be a linked chat identity whose user is an owner of the identity's space; anyone
else, including an unlinked sender, gets `Only an owner of this space can do that.` and nothing
changes. Commands are handled before any routing, so they work while the bot is stopped and never
create a run. The reply confirms the action (`Stopped Crew.`, `Resumed this space.`, …). Global
stops are not available from chat.

In Teams the command is typed as ordinary text and reaches the bot like any message.

### Slack slash commands

In Slack, `/stop` and `/resume` are the app's slash commands. Slack posts them, form encoded, to
the same Request URL as events, `/api/v1/messaging/webhook/slack`, and the same adapter verifies
them: the signature over the timestamp and body with `SLACK_SIGNING_SECRET`, and a timestamp at
most five minutes old (an unsigned, mis-signed or replayed request is answered 401 before
anything runs). A repeated delivery of the same invocation (`trigger_id`) inside ten minutes is
dropped (remembered by the API process). The sender's Slack user id must be a linked identity of an owner, as above; the reply is
ephemeral (only the sender sees it) through Slack's `response_url`, and only `hooks.slack.com`
is ever contacted. The webhook is acknowledged at once and the command finishes in the
background, so a slow stop never trips Slack's three second deadline. With the module off the
command changes nothing and answers `This command is not available.`

Register both commands in the Slack app manifest (the `commands` bot scope is required):

```yaml
features:
  slash_commands:
    - command: /stop
      url: https://<your-hooks-host>/api/v1/messaging/webhook/slack
      description: Stop a bot, or every bot in this space
      usage_hint: "[bot name]"
      should_escape: false
    - command: /resume
      url: https://<your-hooks-host>/api/v1/messaging/webhook/slack
      description: Resume a stopped bot, or this space
      usage_hint: "[bot name]"
      should_escape: false
oauth_config:
  scopes:
    bot:
      - commands
```

Without the slash commands registered, Slack refuses a message that starts with `/`; typing
`@Crew /stop` (a mention first) still works as a plain-text fallback.

## Web app

Space owners get **Stop** / **Resume** in a bot's context menu and **Stop all** / **Resume** in
the space menu; a stopped bot shows a pause mark in the sidebar. The web app polls the state of
the selected space every 15 seconds and after each action. Global stops are API only.

## Audit

With `EXT_AUDIT_LOG=1`, each stop records `control.stop` and each resume `control.resume` in the
session space's chain (a global stop goes on the deployment owner's session space). The actor is
the human; the summary and detail carry the scope, bot, reason and stop ids.

- Stop is fail safe: if its audit insert fails, the stop still takes effect, the error is logged
  with an `error.id`, and the response carries `error_id`.
- Resume is fail closed: the stop row is updated in the same transaction as the audit insert, so
  a failed insert leaves the stop in force and answers `500 { error: "Internal error", error_id }`.

With the audit log off, stops and resumes are not audited.

## Limits

- A tool call that is already executing is not interrupted; a long tool (a slow shell command)
  delays the halt of its run until it returns. Background work it launched is terminated with the
  computer pause.
- Stop state is read through a one second cache, so a check in another process can be up to a
  second stale; enforcement lands within about two seconds and well within five.
- If the worker that holds a running run dies, the run is cancelled when its lease expires and
  the reconciler hands it to the run-start guard.
- Pausing a computer relies on the idle sleep (`SANDBOX_IDLE_MS=0` disables it; then the computer
  keeps running, idle, until resumed work or a manual stop).
- The web app shows stop state for the selected space only; the mobile app has no controls
  (chat commands work from a phone).

## Verification

- `pnpm test` covers command parsing, the paused reply, stop resolution and the cache, the run
  guard (drop, finish-then-halt, watcher), the authorization matrix, space spoofing, route errors
  and the chat handler.
- `pnpm test:integration` adds `packages/db/src/ext-emergency-stop.postgres.test.ts` (persistence
  across a restart, history, fail-closed resume, run cancellation) and
  `packages/testkit/src/ext-emergency-stop.postgres.test.ts` (the HTTP authorization matrix,
  spoofing and isolation, queued runs, a restart, routines, audit fail-safe and fail-closed,
  global stops, an aborted in-flight model call within five seconds, a tool call finishing
  mid-stop, the computer pause, Slack and Teams commands and paused replies, refusal of
  non-owners, signed Slack slash commands (owner, non-owner, unsigned, forged and replayed requests,
flag off), plain-text `/stop` in a Teams 1:1 chat, and the flag off). The surface-level Slack tests
(`packages/adapters/src/slack-commands.test.ts`) run the pinned Slack adapter against the
`SlackEmulator` and check that events still reach the inbound path.
