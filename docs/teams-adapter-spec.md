# Microsoft Teams messaging adapter: spec

## Problem

Rakazo's messaging surface (Chat SDK `chat@4.40.0`) reaches users on iMessage, Slack, WhatsApp,
Telegram, and Feishu/Lark. Organisations on Microsoft 365 have no way to reach their bots from
Teams. This change mounts Microsoft Teams as one more Chat SDK platform, using the official
`@chat-adapter/teams@4.40.0` adapter (pinned to match `chat@4.40.0`). It reuses the existing
provider-neutral contracts, linking flow, and webhook route.

## Scope

In scope:

- 1:1 (personal) Teams chats between a user and the bot, on the same personal-line path as
  Telegram, WhatsApp, and Lark: link-code account linking, inbound messages, bot replies, and
  proactive DMs to linked users.
- A single-tenant Azure Bot registration authenticated with a client secret.
- Web and mobile labels for the `teams` provider. Documentation and `.env.example`.

- Group chats and channels on the team-chat path (added after the first version). The platform
  declares `groups: true, teamChat: true` and enriches room activities with the tenant as
  `workspaceId`, the chat or channel id (without the `;messageid=` thread suffix) as
  `conversationKey`, the thread's root message id as `replyThreadId`, `kind: "mention"` when the
  activity carries a mention entity for the bot account (`28:<appId>`) and `"ambient"` otherwise,
  and `senderIsBot` for `28:` senders. `apps/api/src/app.ts` starts one `TeamChatBridge` per
  platform with `teamChat: true` (Slack, Teams), each keyed by its own provider id, so Teams rooms
  are stored and recovered as Teams conversations. Replies recombine the channel id with the reply
  thread through the adapter's thread-id codec (`resolveMessagingThreadId`). 1:1 chats carry no
  workspace id and stay on the personal line even when `TEAM_CHAT_BOT_ID` is set, so a user's
  personal Teams link keeps working beside the team bot. Without `TEAM_CHAT_BOT_ID` room messages
  are acknowledged and dropped. Manifest requirements (scopes, RSC for ambient) are documented in
  `docs/self-host.md`.

Out of scope (kept for follow-ups; see "Open questions"):

- Multi-tenant bots, federated or managed-identity auth, certificate auth, and sovereign clouds
  (`TEAMS_API_URL`, GCC-High).
- Adaptive Card approvals, typing indicators, and outbound attachments.

## Interface contract

### Environment (inputs)

The names follow the adapter's own auto-detected names. All three are required; if any is
missing, Teams is not mounted.

| Variable              | Meaning                                                    |
| --------------------- | ---------------------------------------------------------- |
| `TEAMS_APP_ID`        | Entra ID (Azure AD) application (client) ID of the bot.    |
| `TEAMS_APP_PASSWORD`  | Client secret of that app registration.                    |
| `TEAMS_APP_TENANT_ID` | Directory (tenant) ID. The only tenant the bot will serve. |

Values are trimmed, and an empty value counts as missing. This matches every other platform
(`messagingEnvFromProcess` and `apps/api/src/env.ts`). All values are passed to the adapter
explicitly, so the adapter never rereads untrimmed `process.env`.

### `MessagingEnvironmentValues` additions

```ts
teamsAppId?: string | undefined;
teamsAppPassword?: string | undefined;
teamsAppTenantId?: string | undefined;
```

### Platform registration (outputs)

`messagingPlatformsFromEnv` appends, after Lark:

```ts
{
  provider: "teams",
  capabilities: { direct: true, groups: true, typing: false, teamChat: true },
  adapter, // createTeamsAdapter({ appType: "SingleTenant", appId, appPassword, appTenantId })
           // wrapped by the tenant guard below
  enrichTeamRoom: enrichTeamsTeamRoom,
}
```

- Webhook: `POST /api/v1/messaging/webhook/teams`. This is the existing generic route, so the
  API needs no new route.
- Thread IDs are the adapter's `teams:<b64url conversationId>:<b64url serviceUrl>[:type]`.
  `providerOfThreadId` resolves them to `teams`.
- Provider ID `teams` passes the existing free-form contracts: `MessagingStatus.providers`,
  `MessagingLinkedIdentity.provider`, and routine `messageProvider` (`^[a-z0-9._-]+$`).
- Labels: web `providerLabel("teams")` and mobile `messagingProviderLabel("teams")` return
  `Microsoft Teams`.

## Security

1. **Inbound authentication (Bot Framework JWT).** Verified in the pinned code: the adapter routes
   every webhook through `@microsoft/teams.apps` `HttpServer.handleRequest`. That code validates
   the `Authorization: Bearer` JWT with `InboundActivityTokenValidator`: RS256 only, the signing
   key comes from the Bot Framework JWKS, the audience is `TEAMS_APP_ID`, the issuer is
   `https://api.botframework.com`, expiry is enforced, and the token's `serviceurl` claim must
   match the activity's `serviceUrl`. A missing or invalid token gets a 401 before any handler
   runs.
2. **Fail closed on the SDK's unauthenticated mode.** `@microsoft/teams.apps` disables JWT
   validation when the environment variable `DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS` is
   truthy, and the Chat SDK adapter cannot override that. After building the adapter, Rakazo
   checks that inbound validation is enabled and that the SDK resolved the configured app and
   tenant IDs. If either check fails, it throws at startup and does not mount an unauthenticated
   webhook.
3. **Single-tenant restriction.** The Bot Framework token does not identify the Teams tenant, so
   the SDK does not restrict tenants for those tokens. A Rakazo tenant guard wraps
   `handleWebhook`. It rejects with **403** before the adapter runs when:
   - neither `conversation.tenantId` nor `channelData.tenant.id` is present,
   - either one differs from `TEAMS_APP_TENANT_ID` (GUIDs are compared case-insensitively), or
   - the bearer token carries a `tid` claim (Entra-issued agentic tokens) that differs from the
     configured tenant.

   The guard adds checks on top of SDK authentication and never replaces it. A request is accepted
   only if it passes the guard **and** the SDK's JWT validation. A spoofed matching tenant with no
   valid token still gets a 401.
4. **No secrets in logs.** Rakazo's code never logs the app password, the bearer token, or message
   bodies. Tenant-guard rejections log the reason, plus at most the last 4 characters of the
   claimed tenant ID. The SDK logs JWT failure reasons (issuer and audience mismatches), never
   the token. Operators should not run with `LOG_LEVEL=debug`, which makes the Teams SDK log
   activity bodies (message content, not secrets).
5. **Generic error responses.** Rejections return bodies with no detail: `Forbidden` (403),
   `{"error":"Missing authorization header"}` or `{"error":"JWT validation failed"}` (401, from
   the SDK), and `Inbound processing failed` (500). The existing 256 KiB body cap applies before
   any parsing.
6. **Outbound targets.** Reply thread IDs embed the `serviceUrl`. The SDK binds that URL to the
   signed token's `serviceurl` claim, so a forged activity cannot redirect replies.

## Acceptance criteria

1. With any of the three variables missing, `messagingPlatformsFromEnv` mounts no `teams`
   platform. With all three present, it mounts `teams` with
   `{ direct: true, groups: true, typing: false, teamChat: true }`.
2. `messagingEnvFromProcess` maps `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, and `TEAMS_APP_TENANT_ID`
   with trim and empty-to-undefined. `loadEnv` in `apps/api` does the same.
3. The adapter is built as `SingleTenant` with the configured tenant. It does not pick up
   `CLIENT_ID`, `CLIENT_SECRET`, or `TENANT_ID` values from the process environment.
4. With `DANGEROUSLY_ALLOW_UNAUTHENTICATED_REQUESTS=true`, mounting Teams throws.
5. A webhook with no `Authorization` header, a garbage token, a token signed by an unknown key, or
   a wrong-audience token gets a 401 and never reaches the inbound sink.
6. A webhook for a different tenant, or with no tenant, gets a 403 and never reaches the inbound
   sink, even with a valid token. A spoofed matching tenant with no token gets a 401.
7. A validly signed, correct-tenant personal message reaches the inbound sink as
   `{ provider: "teams", isDirect: true, from: <29:… user id>, content }`, and the response is
   2xx.
8. A validly signed group-chat or channel message reaches the inbound sink with the tenant as
   `workspaceId`, the room as `conversationKey`, the thread root (channels) as `replyThreadId`,
   and `kind` `mention` or `ambient`; with `TEAM_CHAT_BOT_ID` set it is handled by the Teams
   `TeamChatBridge`, otherwise it is acknowledged and dropped.
9. A sink failure returns 500, so Bot Framework retries.
10. Teams 1:1 activities carry no `workspaceId`, so `prefersTeamChatSurface` keeps them on the
    personal line; room activities do and reach the Teams bridge.
11. The web and mobile provider labels return `Microsoft Teams`.

## Edge cases

- Non-JSON body: the guard has no tenant, so the result is 403.
- Teams GUID casing differs between Azure and payloads: compare case-insensitively.
- "Test in Web Chat" in the Azure portal sends activities with no Teams tenant, so they are
  rejected by design.
- Proactive DMs from the worker process: the in-memory state has no cached tenant, so the adapter
  falls back to the configured `appTenantId`.
- Messages the bot sent itself (`28:<appId>`) are dropped by the surface (`author.isMe`).

## Test plan (written before implementation)

- `packages/adapters/src/messaging-platforms.test.ts`: env gating, mapping and trim, capabilities,
  SingleTenant config, ignoring generic `CLIENT_*` env, and the fail-closed unauthenticated-env
  check.
- `packages/adapters/src/teams-messaging.test.ts`: offline conformance against the pinned adapter
  and SDK. It uses locally generated RS256 keys, and the SDK's JWKS lookup is pointed at the test
  public key, so signature, audience, issuer, expiry, and `serviceurl` checks all run for real.
  Cases: missing, invalid, unknown-key, and wrong-audience tokens (401); wrong, missing, and
  spoofed tenants and wrong Entra `tid` (403); a valid DM delivered; group and channel ignored;
  a sink failure gives 500.
- `packages/contracts/src/index.test.ts`: `teams` accepted by `MessagingStatusSchema` and
  `CreateRoutineInput.messageProvider`.
- `apps/api/src/env.test.ts` (or an equivalent): `TEAMS_*` parsing.
- `apps/api/src/team-chat-startup.test.ts`: a Teams DM does not prefer the team-chat surface.
- Web `providerLabel` and mobile `messagingProviderLabel` return `Microsoft Teams`.

## Open questions

- **Identity linking.** Linking uses the existing DM link code, with address = Teams user ID
  (`29:…`). Should Rakazo also match on the Entra object ID or UPN (for example, auto-link a user
  whose verified email matches a Rakazo account)?
- **Approvals.** Rakazo approvals could render as Adaptive Cards (the adapter supports buttons and
  `onAction`) instead of text replies.
- **Attachments.** Inbound attachment URLs need bot-token-authenticated fetches. `mediaUrl`
  currently passes the raw URL through, as other platforms do.
