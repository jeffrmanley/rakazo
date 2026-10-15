# Tamper-evident audit log

Fork extension, spec section 5.4. Off by default; `EXT_AUDIT_LOG=1` turns it on for the API
and the worker. With the flag off nothing changes: no rows are written, the audit route is not
mounted, and the message and tool paths run exactly as upstream.

## What is recorded

Every event belongs to one space and is appended to that space's chain:

| Kind | Written when | Actor |
| --- | --- | --- |
| `message.in` | A user-role message is written to a thread: web, mobile, desktop, a messaging webhook (Slack, Teams, Telegram, …), a webhook routine, or a bot-to-bot delivery. | The sending person, or the sending bot for bot-to-bot deliveries. |
| `message.out` | A bot-role message is written to a thread: the final reply, mid-turn narration, or the sending bot's own copy of a bot-to-bot message. | The bot. |
| `tool.call` | The model issues a tool call, before anything executes: every call, including tools the model runtime runs itself (`run_subagent`, `ask_user`, `request_takeover`, a sub-agent's own calls) and calls that never run (an unknown tool name, invalid arguments, the tool-call limit, a turn that was aborted, or a refusal by the emergency stop, a budget halt or an approval). | The bot. |
| `tool.result` | The tool returned, threw, paused for approval, or the call was refused, before the result reaches the model. A refused call's result is `outcome: "error"` with the refusal. | The bot. |

System notes (`role: "system"`) are not chat messages and are not recorded. The remaining kinds
in the type (`credential.use`, `approval.request`, `approval.decision`, `verifier.verdict`,
`budget.block`, `control.stop`, `control.resume`, `policy.change`) exist for the emergency-stop
and budget modules; they call the same writer.

`detail` is structured and bounded. Message events carry the thread id, the message sequence,
the role and the block kinds, never the text: a chat message can be cleared later, an audit row
cannot, so the immutable log holds references rather than copies. Tool calls carry the tool
name, the execution id and the arguments after redaction. Tool results carry the outcome,
duration, the result's shape (content types, top-level keys or length) and a sanitized error
message, never the result body.

## Design

Tables (migration `20261011120000_ext_audit_log`):

- `ext_audit_events`: one row per event, `(spaceId, seq)` unique. `seq` is the position in the
  space's chain. No foreign keys: deleting a space, bot, run or thread never cascades here.
- `ext_audit_chain_heads`: one row per space with `lastSeq`, `lastHash` and `sealedThroughSeq`.
  It is the per-space lock (selected `FOR UPDATE` on every append) and the seal cursor. It is
  mutable by design; integrity never depends on it.
- `ext_audit_segments`: one row per hourly seal, recording the chain tip for a `[fromSeq, toSeq]`
  range and the export path when one was written.

Hashing:

```
hash = sha256( prevHash + canonicalJson({ id, spaceId, seq, botId, runId, at, actor, kind, summary, detail, model? }) )
```

`canonicalJson` is `JSON.stringify` with object keys sorted recursively. `at` is hashed as the
ISO string and stored as a millisecond timestamp, so the stored row re-serializes to exactly
the hashed text. `model` is included only when present. The first event of a space links to
the genesis hash (64 zeros). `detail` is stored as `jsonb`; the writer hashes the redacted value
after it has been sanitized for `jsonb`, and the Postgres test suite checks that floats, large
numbers, unicode and nested values round-trip to the same canonical text.

Append-only: `BEFORE UPDATE OR DELETE` row triggers and `BEFORE TRUNCATE` statement triggers on
`ext_audit_events` and `ext_audit_segments` raise `insufficient_privilege`, whichever role runs
the API or the worker. A deployment with a separate application role should also revoke the
privileges outright, which removes the trigger from the trust boundary:

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON ext_audit_events, ext_audit_segments FROM rakazo_app;
GRANT INSERT, SELECT ON ext_audit_events, ext_audit_segments TO rakazo_app;
GRANT SELECT, INSERT, UPDATE ON ext_audit_chain_heads TO rakazo_app;
```

Fail closed:

- Message writes audit inside the caller's transaction, before the message row is created. A
  failed audit insert rolls the whole write back: no message, no run, no event.
- Tool calls audit before execution; a failed insert means the tool does not run. Tool results
  audit before the result is returned; a failed insert withholds the result. Either failure aborts
  the run, which ends `failed` with the generic message below. The executor's audit wrapper sits
  outside the emergency stop and budget guards, so their refusals are recorded too; calls the
  model runtime settles itself go through the same writer (`AgentRunRequest.auditToolCall`),
  with the same rules. A call refused before any tool runs is recorded as its call and its
  refusal once the runtime has refused it.
- Every failure is an `AuditWriteError`. Its message is `Internal error (error_id: <uuid>)`; the
  cause is logged once with `error.id` and never reaches a client, a chat line or a tool result.
  RPC callers get that message and `{ error_id }` in the error data; a chat sender whose message
  was dropped gets the same text on their line.

Redaction (`redactAuditValue`, `redactAuditText`):

- Keys matching password, passwd, secret, token, api key, authorization, cookie, credential,
  private key, bearer or session id keep their name and lose their value.
- Known secret values of the run (model keys, connector credentials, request_secret answers) are
  scrubbed from every string, as are token-shaped values: bearer headers, JWTs, `sk-`, GitHub,
  Slack and AWS key prefixes, PEM private-key blocks, and `key=value` pairs for those names.
- Strings are cut at 512 characters, nesting at 8 levels, containers at 100 members, and
  unpaired UTF-16 surrogates and NUL bytes are removed.

Space isolation: `spaceId` is never an input. The message hook reads it from the thread row;
the tool hook takes it from the run; the API takes it from the authenticated actor. The query
string, headers and body of `GET /api/v1/audit` cannot widen it (`x-rakazo-space-id` only
selects among the caller's own memberships and answers 401 otherwise).

## API

`GET /api/v1/audit?botId&runId&from&to&cursor&limit`, session cookie or bearer token.

- Events come in chain order (`seq` ascending), at most 100 per page, 50 by default.
- `cursor` is the `seq` of the last event seen; the response's `nextCursor` is null on the last
  page. `from` and `to` are ISO 8601 times filtering `at`. Malformed values answer 400.
- Responses are `cache-control: no-store`.

## Sealing and export

Once an hour the API seals every space whose chain moved since the last seal: a segment row
records `fromSeq`, `toSeq`, the chain tip hash and the time. With `EXT_AUDIT_EXPORT_DIR` set,
each segment is first written to `<dir>/<spaceId>/<from>-<to>.jsonl` (one event per line, as
served by the API) and `<from>-<to>.seal.json`; the seal row commits only after the files are
written, so a failed copy leaves the range open for the next hour. Segments are append-only like
events, and the verifier checks each segment's recorded hash against the event it names.

## Verifying the chain

```bash
pnpm --filter @rakazo/api audit:verify                 # every space
pnpm --filter @rakazo/api audit:verify --space <id>    # one or more spaces
```

The verifier reads the rows in `seq` order, recomputes every hash from the stored row and
reports the first break: a `gap` (a missing sequence), a `prev_hash` mismatch (a row re-linked
to a different predecessor), a `hash` mismatch (a row whose content changed), or a `segment`
whose recorded tip no longer matches. Exit code 1 means at least one space is broken. An
exported segment can be checked offline with the same rule: each line's `hash` must equal
sha256 of the previous line's `hash` followed by the canonical JSON of the line without
`prevHash` and `hash`.

Programmatic access: `verifyAuditChain(prisma, { spaceId })` in `@rakazo/db`.

## Extension points for later modules

- `createAuditWriter(prisma)` returns `{ record, recordInTransaction }`; `installAuditWriter`
  and `getAuditWriter` share one writer per process. Emergency stop and budgets record
  `control.stop`, `control.resume` and `budget.block` through it, inside their own transactions
  where they have one.
- `AuditEventInput.model` carries provider, model id, token counts and cost for events that have
  them; it is part of the hash when present.
- `loadExtEnv` already parses `EXT_EMERGENCY_STOP`, `EXT_BUDGETS` and the budget and
  concurrency limits with the spec defaults.

## Verification

- `pnpm test` runs the unit tests: env parsing, canonical JSON and hashing, redaction, the
  writer with a fake transaction, listing, verification, sealing, the message and tool hooks,
  the HTTP route (including spoofed space ids and malformed filters), the RPC error mapping,
  the chat failure reply and the sealer timer.
- `pnpm test:integration` adds `packages/db/src/ext-audit.postgres.test.ts` (chaining under
  concurrency, jsonb round-trip, transactional rollback, append-only triggers, tamper detection
  after an administrator disables the trigger, space-scoped listing, sealing and export) and
  `packages/testkit/src/ext-audit-log.postgres.test.ts` (a full chat turn with a tool call on
  one chain, the API's space scoping against spoofed query, header and body, fail-closed
  rejection with an error id, and no writes with the flag off).
- `packages/testkit/src/pi-offline-governance.test.ts` (in `pnpm test`) checks that the Pi
  runtime offers every call the executor never sees to the audit hook once, and runs no
  in-process tool whose record failed; the red-team case `audit-coverage`
  (`docs/governance/evals.md`) drives unknown, invalid, sub-agent, gated and stop-refused calls
  end to end.

## Limitations

- The trigger stops the application role from changing rows; a superuser or the table owner can
  disable it. The chain makes such a change visible (the tamper test does exactly that) but
  cannot prevent it. Protect the database role and keep the hourly export off the box.
- A whole-chain truncation by a superuser leaves nothing to verify locally; the exported seal
  records are the evidence that events existed. The verifier reports an empty chain as intact.
- Messages are audited at the thread write, which is also where group fan-out, bot-to-bot
  delivery and webhook routines land. Delivery to an external chat platform (the mirrored copy
  sent back to Slack or Teams) is not a separate event; the outbound message it mirrors is.
- The arguments of a tool call are recorded after redaction by key name, known secret value and
  token shape. A secret pasted into a free-text argument that matches none of those is stored.
  Message text is never stored, for the same reason.
- Model usage (`model`) is not attached to message events yet; the budget module owns token
  accounting and will record it with `budget.block` and its own events.
- Sealing runs in the API process. Two API replicas seal the same ranges only once (the head row
  is locked and re-checked), but the export is written by whichever replica wins and lands on
  that replica's `EXT_AUDIT_EXPORT_DIR`.
