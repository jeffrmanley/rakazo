# Approvals

Fork extension (governance). Off by default; `EXT_APPROVALS=1` turns it on. It needs the audit
log: `EXT_APPROVALS=1` without `EXT_AUDIT_LOG=1` fails startup. Set it for the API and the worker
alike: the API records its value in `deployment_settings.extApprovals` at startup, and a worker
with a different value refuses to start (`EXT_APPROVALS is 1 in the worker but 0 in the API; set
the same value for both`). With the flag off nothing changes for new calls: no tool call waits on
the module, no card goes to chat, the policy routes are not mounted (404), card button clicks
have no handler and bot settings look as before. The web app learns which modules run from
`GET /api/v1/ext/modules` (`approvals: true|false`).

The module builds on the upstream approval of consequential actions: the same intended
external effect, the same paused run and web approval card, the same resume and replay of the
exact approved request. It adds risk classes, approvers, chat cards, expiry and an audit trail.

## Risk classes

Every tool call has one risk class:

| Class | What it covers |
| --- | --- |
| `read` | No side effect: reading files, history, memory, the web. |
| `write-internal` | A side effect inside the bot's own computer and the deployment: `shell`, `write_file`, `computer_act`, `browser_act`, `launch_app`, `open_path`, memory, schedule, skills, tickets, archiving bots, creating spaces. |
| `write-external` | A side effect outside the deployment, or another actor made to act: `destination.write`, cloud agents, messages to another person's agent, `message_bot`, `handoff_to_bot`, `spawn_bot`, `add_mcp_server`, and every connector tool the upstream rules call consequential (a declared write, a mutating name, or a name that is not clearly a read). |

The built-in tools are listed per class in `packages/core/src/ext-approvals.ts`. The rule is
default deny: a tool nobody classified, built-in or connector, is `write-external`. A
connector's "read only" hint never relaxes a mutating name, as upstream. Every tool of an MCP
server that a bot added itself (`add_mcp_server`, recorded in `mcp_servers.addedByBotId`) is
`write-external` whatever its name; servers a person added keep the upstream rule.

`ask_user`, `end_call`, `request_secret` (its own secure entry card) and `request_takeover`
never wait on an approval. Every other tool waits when its class is gated, read-only built-in
tools included.

### What approvals do not cover

Approvals gate tool calls by class. The computer tools (`shell`, `browser_act`,
`computer_act`, `launch_app`, `open_path`) are `write-internal`, yet a command or a browser can
reach the internet: with only `write-external` gated (the default), a bot can still cause
external effects through its computer. Those are contained by the sandbox's egress controls and
the planned credential gateway, not by approvals. For high-risk bots also gate
`write-internal`; bot settings say so while only External actions are gated.

## Settings

Each bot has a policy, keyed by its space and bot: the classes that wait for a person (default
`write-external`) and its approvers. Only a space owner sees and changes it, in bot settings
under **Approvals**:

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
`policy.change` in the same transaction (fail closed).

## Behaviour

A call in a gated class becomes a mandatory approval: no "always allow" rule, auto review or
model judgment can let it through, and the web card offers **Allow once** and **Deny** only.

1. The executor records the intended effect (upstream), then the request
   (`ext_approvals`): tool, risk class, every argument and the bot's stated reason (the model's
   text before the call) with secrets redacted but nothing cut, the approvers eligible at that
   moment, a 30 minute deadline, and the SHA-256 of the tool name and its canonical arguments.
   `approval.request` is written in the same transaction; if that fails there is no request, no
   card and no execution, and the run halts with the error id, like any audit failure.
2. The run pauses with the web approval card, and each approver with a linked chat identity
   gets a card in a 1:1 chat (see Chat). A requester who is not an approver gets a notice in
   the chat the run came from: `Crew is waiting for approval to run destination.write.`
3. A decision from the web card, a Slack button or a Teams button goes through one path:
   under a row lock, a pending request is decided once. The approval row, `approval.decision`
   and the run's resume (the same answer the web card records) commit together; a failed
   audit write leaves everything pending and nothing runs.
4. Before an effect is claimed for execution, in every process whatever its flag: an effect
   with an approval request runs only if that request was approved and the hash of the call
   about to run matches; with the module on, a gated call never runs on an upstream approval
   that has no request. The executor replays exactly the approved request (upstream), so a
   different tool or different arguments never execute on that approval.

Who may decide is checked on the server against the decider's verified identity: a web
session's user, or for a chat click the linked identity of the verified sender (see below).
That user must be on the request's approver list, still a member of the space, and still
eligible under the bot's current policy (the configured approvers, or the space owners plus the
requester). Taking someone off the bot's approvers, or demoting an owner, ends their authority
over pending requests; leaving and rejoining the space restores nothing the current policy does
not grant. Nothing in the card or the button counts as an identity.

| Situation | Result |
| --- | --- |
| An eligible approver approves | `allow`: the call runs once. |
| An eligible approver denies | `deny`: the model gets the upstream declined result and does not retry. |
| Someone else clicks (another member, another space, an unlinked chat account, an approver taken off the list) | Refused with `You can't decide this approval.`; nothing changes; the attempt is logged. |
| A second click, a retry or a click elsewhere after the decision | `This approval was already decided.`; nothing runs again. |
| 30 minutes pass | `expired`, counted as a deny. |
| Nobody on the list is still eligible (left the space, or taken off the approvers) | `invalid` (a deny). |
| The bot is stopped (emergency stop) | Not approved: a decision after the stop resolves `invalid`, and a call approved just before the stop is halted before its side effect. Both checks read the stop state from the database, not the one second stop cache, so a stop made in another process counts at once. |
| The run ended before a decision (a stop cancels waiting runs) | `invalid`. |

Expiry, lost approvers and ended runs are closed by a sweep in the API process every 15
seconds, which reads every pending request page by page. A click after the deadline resolves
the request as expired at once.

## Chat

Each approver with a linked identity in the space gets one card, in a 1:1 chat with the app:
for the requester the chat app the run came through, otherwise the bot's home identity, an
identity of this bot, or the one the person used last. Approvers without a linked identity
decide in the web app. Every card resolves the same request; once it is decided, by any
surface, every card is replaced with the outcome (`Approved by Dana`, `Denied by Dana`,
`Expired without a decision`, `No longer valid`) and no buttons.

The card shows the bot, the action and its risk class, `Call 1a2b3c4d` (the first eight hex
characters of the call hash, also on the web card, so approvers can match them), the reason,
every argument with keys sorted at every depth (the order the hash uses), and the deadline in
UTC, with **Approve** and **Deny**. Everything on it is escaped for the platform: in Slack `&`,
`<` and `>` become entities (no mentions, links or `<!channel>`) and the arguments sit in code
blocks no text can close; in Teams Markdown punctuation is escaped.

A card cannot carry everything: Slack takes at most 3,000 characters per section, and the card
budget is 12,000 escaped characters in Slack and 15,000 in Teams. A call that does not fit is
shown up to the budget, followed by `12,345 characters hidden. Open the web app to see the full
call.`, and the card offers **Deny** only. Nothing is cut silently, so padding the arguments
cannot hide the real recipient behind an Approve button. The web card always shows the whole
call (reason, call label and every argument), scrollable.

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

- `approval.request` (actor: the bot): tool, risk class, redacted arguments, reason, approvers,
  deadline.
- `approval.decision` (actor: the deciding user, or `system` for expiry and invalidation):
  `decision` (`allow`, `deny`, `expired`, `invalid`), `via` (`web`, `slack`, `teams`, `system`),
  the interaction id and a note for `invalid`.

Both are written in the transaction of the change they describe, so an audit failure means no
request, or no decision and no execution. Refused clicks are logged server-side, not audited.

## Limits

- The web approval card is in the bot's thread, which only the bot's owner sees (upstream).
  Other approvers decide from Slack or Teams; a bot owner who is not an approver is refused.
- Cards go to 1:1 chats only, never to team rooms. Posting is best effort: if a card fails,
  the web card and the other cards still work and the error is logged.
- The approver list is fixed when the request is made; the current policy can only narrow it.
- Interaction ids are remembered by the API process that received the click; across processes
  the row lock still makes the decision single use.
- The worker checks the API's flag at startup only; change both together and restart both.
- The mobile app has no policy settings; its approval card uses the same server path.
- Teams identities are matched by the sender id linked identities use, not by the AAD object id.

## Verification

- `pnpm test` covers risk classes, default deny, model-added MCP tools and exempt tools, policy
  parsing, expiry, approver standing against the current policy, the call hash and its label,
  canonical arguments, full redaction, card building and the overflow rule (the padding attack,
  Slack and Teams limits), Slack/Teams escaping, Slack and Teams clicks on the messaging surface
  (signed, forged, stale, repeated), card destinations per approver and the requester notice,
  the flag and its coupling to the audit log, and the bot settings section.
- `pnpm test:integration` adds `packages/db/src/ext-approvals.postgres.test.ts` (single use,
  concurrent decisions, non-approvers, approvers taken off the policy, leaving and rejoining,
  tenant isolation, expiry, approver loss, ended runs, the policy key, paginated roster and
  sweep, the worker flag check, emergency stop, audit fail-closed, the hash check) and
  `packages/testkit/src/ext-approvals.postgres.test.ts` (Slack approval via a signed
  interaction, Teams approval via a JWT-validated invoke, deny, expiry with a fake clock,
  non-approver and forged clicks, replayed clicks, another space's user, a web decision after
  a chat card, cards to every approver and the requester notice, the padding attack end to end,
  an upstream approval without a request, approver loss, emergency stop before the click and
  between approval and execution, the policy API, a gated read on the Pi runtime, and the flag
  off, including a pending request that still blocks execution there).
