# Approvals

Fork extension (governance). Off by default; `EXT_APPROVALS=1` turns it on. Set it for the API
and the worker alike. With the flag off nothing changes: no tool call waits on the module, no
card goes to chat, the policy routes are not mounted (404), card button clicks have no handler
and bot settings look as before. The web app learns which modules run from
`GET /api/v1/ext/modules` (`approvals: true|false`).

The module builds on the upstream approval of consequential actions: the same intended
external effect, the same paused run and web approval card, the same resume and replay of the
exact approved request. It adds risk classes, approvers, chat cards, expiry and an audit trail.

## Risk classes

Every tool call has one risk class:

| Class | What it covers |
| --- | --- |
| `read` | No side effect: reading files, history, memory, the web, `ask_user`. |
| `write-internal` | A side effect inside the deployment: the bot's own computer (`shell`, `write_file`, `computer_act`, `browser_act`), its memory, schedule, skills, tickets, and other bots and spaces (`spawn_bot`, `archive_bot`, `create_space`). |
| `write-external` | A side effect outside the deployment: `destination.write`, cloud agents, messages to another person's agent, and every connector tool the upstream rules call consequential (a declared write, a mutating name, or a name that is not clearly a read). |

The built-in tools are listed per class in `packages/core/src/ext-approvals.ts`. The rule is
default deny: a tool nobody classified, built-in or connector, is `write-external`. A
connector's "read only" hint never relaxes a mutating name, as upstream.

`request_secret` keeps its own secure entry card and is never gated a second time; read-only
tools are never gated.

## Settings

Each bot has a policy: the classes that wait for a person (default `write-external`) and its
approvers. Only a space owner sees and changes it, in bot settings under **Approvals**:

- one switch per class (**Reads**, **Internal changes**, **External actions**); all off means
  the bot never waits;
- **Approvers**: a switch per member of the space. None chosen (the default) means the space
  owners plus the user who started the run.

API (session cookie or bearer token; the space is the session's, a `spaceId` in the body or
query is ignored; anyone but a space owner gets `404`, like a bot in another space):

| Route | Body | Result |
| --- | --- | --- |
| `GET /api/v1/approvals/bots/:botId` | | `{ policy, defaults, riskClasses, members }` |
| `PUT /api/v1/approvals/bots/:botId` | `{ gatedClasses?: RiskClass[], approverUserIds?: string[] }` | same as `GET` |

Approvers must be members of the space (`400` otherwise; at most 100). A change is recorded as
`policy.change` in the same transaction (fail closed with the audit log on).

## Behaviour

A call in a gated class becomes a mandatory approval: no "always allow" rule, auto review or
model judgment can let it through, and the web card offers **Allow once** and **Deny** only.

1. The executor records the intended effect (upstream), then the request
   (`ext_approvals`, migration `20261017120000_ext_approvals`): tool, risk class, the
   arguments and the bot's stated reason (the model's text before the call) with secrets
   redacted, the approvers fixed at that moment, a 30 minute deadline, and the SHA-256 of the
   tool name and its canonical arguments. With the audit log on, `approval.request` is written
   in the same transaction; if that fails there is no request, no card and no execution, and
   the run halts with the error id, like any audit failure.
2. The run pauses with the web approval card, and a card goes to the chat where the run's
   conversation lives: the chat app its message came through, else the bot's home identity,
   else nothing (web only). Platforms without cards (SMS, WhatsApp, Telegram) stay web only.
3. A decision from the web card, a Slack button or a Teams button goes through one path:
   under a row lock, a pending request is decided once. The approval row, `approval.decision`
   and the run's resume (the same answer the web card records) commit together; a failed
   audit write leaves everything pending and nothing runs.
4. On resume the executor replays exactly the approved request (upstream) and, before the
   side effect, checks that the request is approved and that the hash of the call about to
   run matches. A different tool or different arguments never execute on that approval.

Who may decide is checked on the server against the decider's verified identity: a web
session's user, or for a chat click the linked identity of the verified sender (see below),
then that user's current membership in the request's space and the approver list. Nothing in
the card or the button counts as an identity.

| Situation | Result |
| --- | --- |
| A listed approver approves | `allow`: the call runs once. |
| A listed approver denies | `deny`: the model gets the upstream declined result and does not retry. |
| Someone else clicks (another member, another space, an unlinked chat account) | Refused with `You can't decide this approval.`; nothing changes; the attempt is logged. |
| A second click, a retry or a click elsewhere after the decision | `This approval was already decided.`; nothing runs again. |
| 30 minutes pass | `expired`, counted as a deny. |
| An approver leaves the space | They can no longer decide. If nobody on the list is left, the request becomes `invalid` (a deny). |
| The bot is stopped (emergency stop) | Not approved: a decision after the stop resolves `invalid`, and a call approved just before the stop is halted before its side effect. Both checks read the stop state from the database, not the one second stop cache, so a stop made in another process counts at once. |
| The run ended before a decision (a stop cancels waiting runs) | `invalid`. |

Expiry, lost approvers and ended runs are closed by a sweep in the API process every 15
seconds, so they resolve within 15 seconds of the event. A click after the deadline resolves
the request as expired at once.

## Chat

The card shows the bot, the action and its risk class, the reason, the arguments (redacted,
at most 2,000 characters) and the deadline in UTC, with **Approve** and **Deny**. Everything on
it is escaped for the platform: in Slack `&`, `<` and `>` become entities (no mentions, links
or `<!channel>`) and the arguments sit in a code block a fence in the text cannot close; in
Teams Markdown punctuation is escaped. Once decided, by any surface, the card is replaced with
the outcome (`Approved by Dana`, `Denied by Dana`, `Expired without a decision`,
`No longer valid`) and no buttons.

**Slack.** Buttons are Block Kit actions. Slack posts the click to the app's interactivity
Request URL, which is the events URL, `/api/v1/messaging/webhook/slack`; the pinned adapter
verifies the signature over the timestamp and body with `SLACK_SIGNING_SECRET` and rejects a
request older than five minutes (`401` before anything runs). The clicker is the `user.id` of
the signed payload, looked up as a linked identity. Replies only the clicker sees go through
the click's `response_url` (only `hooks.slack.com` is contacted). Enable interactivity in the
app manifest:

```yaml
settings:
  interactivity:
    is_enabled: true
    request_url: https://<your-hooks-host>/api/v1/messaging/webhook/slack
```

**Teams.** The card is an Adaptive Card. A click arrives on `/api/v1/messaging/webhook/teams`
as an `adaptiveCard/action` invoke (or a message with the submit value, depending on the
client); both pass the Bot Framework JWT validation and the single-tenant check of the regular
Teams path. The clicker is the activity's sender id (`from.id`), the address linked Teams
identities are stored under. Teams has no ephemeral messages: the refusal and "already
decided" replies are posted only in a 1:1 chat (where approval cards are posted).

Each click carries an interaction id (Slack `trigger_id`, the Teams activity id); a repeated
delivery of the same id within ten minutes is dropped before it reaches the decision. The
webhook is acknowledged at once and the decision finishes in the background, inside Slack's
three second deadline.

## Audit

With `EXT_AUDIT_LOG=1`:

- `approval.request` (actor: the bot): tool, risk class, redacted arguments, reason, approvers,
  deadline.
- `approval.decision` (actor: the deciding user, or `system` for expiry and invalidation):
  `decision` (`allow`, `deny`, `expired`, `invalid`), `via` (`web`, `slack`, `teams`, `system`),
  the interaction id and a note for `invalid`.

Both are written in the transaction of the change they describe, so an audit failure means no
request, or no decision and no execution. Refused clicks are logged server-side, not audited.
With the audit log off, approvals still work and are not audited.

## Limits

- The web approval card is in the bot's thread, which only the bot's owner sees (upstream).
  Other approvers decide from Slack or Teams; a bot owner who is not on the list is refused.
- A card goes only to the 1:1 chat of the run's chat identity or the bot's home identity, not
  to team rooms. Posting is best effort: if it fails, the web card still works and the error
  is logged.
- Approvers are fixed when the request is made; a later settings change applies to the next
  request.
- Interaction ids are remembered by the API process that received the click; across processes
  the row lock still makes the decision single use.
- The mobile app has no policy settings; its approval card uses the same server path.
- Teams identities are matched by the sender id linked identities use, not by the AAD object id.

## Verification

- `pnpm test` covers risk classes and default deny, policy parsing, expiry, approver
  resolution, the call hash, card redaction and Slack/Teams escaping, Slack and Teams clicks on
  the messaging surface (signed, forged, stale, repeated), card destinations, the flag, and the
  bot settings section.
- `pnpm test:integration` adds `packages/db/src/ext-approvals.postgres.test.ts` (single use,
  concurrent decisions, non-approvers, tenant isolation, expiry, approver loss, ended runs,
  emergency stop, audit fail-closed, the hash check) and
  `packages/testkit/src/ext-approvals.postgres.test.ts` (Slack approval via a signed
  interaction, Teams approval via a JWT-validated invoke, deny, expiry with a fake clock,
  non-approver and forged clicks, replayed clicks, another space's user, a web decision after
  a chat card, approver loss, emergency stop before the click and between approval and
  execution, the policy API, and the flag off).
