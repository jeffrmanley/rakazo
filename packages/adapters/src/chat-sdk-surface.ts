import { AsyncLocalStorage } from "node:async_hooks";
import { createMemoryState } from "@chat-adapter/state-memory";
import type {
  AdapterContext,
  AdapterDescriptor,
  MessagingAction,
  MessagingCapabilities,
  MessagingCard,
  MessagingCommand,
  MessagingInboundEvent,
  MessagingInboundMessage,
  MessagingOutboundStatus,
  MessagingPlatformDescriptor,
  MessagingSendRequest,
  MessagingSendResult,
  MessagingSurface,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { ActionEvent, Adapter, Message, SlashCommandEvent, Thread } from "chat";
import { Chat } from "chat";
import { CARD_PROVIDERS, toChatCard } from "./messaging-card.js";

/** Per-webhook drain of Chat SDK waitUntil work + inbound sink failures. */
const webhookDrain = new AsyncLocalStorage<{
  pending: Promise<unknown>[];
  failed: boolean;
}>();

/** Inbound webhook bodies larger than this are rejected before parsing. */
export const MESSAGING_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

/**
 * One messaging platform mounted on the surface. The Chat SDK adapter owns
 * webhook verification, payload translation, and platform API calls; the
 * extra hooks cover the few per-platform facts the SDK does not surface.
 */
export interface MessagingPlatform {
  provider: string;
  capabilities: MessagingCapabilities;
  adapter: Adapter;
  /** Deterministic 1:1 thread id for platforms without openDM (sendblue). */
  directThreadId?: (address: string) => string;
  /** Delivery-status events the Chat SDK drops (sendblue is_outbound posts). */
  peekStatus?: (payload: unknown) => MessagingOutboundStatus | null;
  /** Group roster addresses from the raw inbound payload, excluding our line. */
  participants?: (raw: unknown) => string[];
  /** Group display name from the raw inbound payload. */
  channelName?: (raw: unknown) => string | null;
  /** User-facing transport carried by the raw message when it differs from the provider. */
  transport?: (raw: unknown) => string | null;
  /**
   * Optional team-room enrichment (workspace id, mention/ambient kind, bot
   * sender, reply thread) derived from the raw platform payload.
   */
  enrichTeamRoom?: (
    raw: unknown,
    base: MessagingInboundMessage,
  ) => Partial<MessagingInboundMessage>;
  /** Reply only the sender of a slash command sees (Slack response_url). */
  respondToCommand?: (raw: unknown, body: string) => Promise<void>;
}

/** How long a slash command's per-invocation id is remembered to drop a repeated delivery. */
const COMMAND_DEDUPE_MS = 10 * 60_000;
const COMMAND_DEDUPE_MAX = 10_000;

/**
 * MessagingSurface over the Chat SDK (github.com/vercel/chat): one bot
 * presence across every mounted platform. Orchestration stays upstream —
 * this class only translates between Chat SDK events/calls and the
 * provider-neutral contract.
 */
export class ChatSdkMessagingSurface implements MessagingSurface {
  private readonly chat: Chat<Record<string, Adapter>>;
  private readonly byProvider = new Map<string, MessagingPlatform>();
  private sink: ((event: MessagingInboundEvent) => Promise<void>) | undefined;
  private initialized: Promise<void> | undefined;
  private readonly seenCommands = new Map<string, number>();
  private readonly pendingCommands = new Set<Promise<void>>();
  private readonly seenActions = new Map<string, number>();
  private readonly pendingActions = new Set<Promise<void>>();

  constructor(platforms: MessagingPlatform[], options: { userName?: string } = {}) {
    if (platforms.length === 0) throw new Error("ChatSdkMessagingSurface needs >=1 platform");
    for (const platform of platforms) this.byProvider.set(platform.provider, platform);
    this.chat = new Chat({
      userName: options.userName ?? "rakazo",
      adapters: Object.fromEntries(platforms.map((p) => [p.provider, p.adapter])),
      state: createMemoryState(),
      // The SDK default ("drop") takes a per-conversation lock and discards
      // any message that arrives while it is held — and the LockError is
      // swallowed into waitUntil, so the webhook still ACKs 200 and the
      // vendor never retries. Two texts in quick succession would lose the
      // second. Each inbound message already runs inside its own webhook's
      // waitUntil task, so process them independently and let the per-message
      // client nonce downstream handle replay.
      concurrency: "concurrent",
    });
    const deliver = async (thread: Thread, message: Message) => {
      const event = this.toInbound(thread, message);
      if (!event) return;
      try {
        await this.sink?.(event);
      } catch (error) {
        // processMessage hands waitUntil a swallowed promise, so track sink
        // failures here and turn them into HTTP 5xx after the drain.
        const drain = webhookDrain.getStore();
        if (drain) drain.failed = true;
        throw error;
      }
    };
    // Priority routing makes these disjoint: DMs, then @-mentions in
    // unsubscribed threads, then the catch-all pattern for everything else.
    // Subscribed threads skip the catch-all and only fire onSubscribedMessage
    // (chat SDK docs / dispatchToHandlersWithSignal); register deliver there too.
    this.chat.onDirectMessage(deliver);
    this.chat.onNewMention(deliver);
    this.chat.onSubscribedMessage(deliver);
    this.chat.onNewMessage(/(?:)/, deliver);
  }

  describe(): AdapterDescriptor<{ providers: string[] }> {
    return {
      id: "chat-sdk",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { providers: [...this.byProvider.keys()] },
    };
  }

  platforms(): MessagingPlatformDescriptor[] {
    return [...this.byProvider.values()].map((platform) => ({
      provider: platform.provider,
      capabilities: platform.capabilities,
    }));
  }

  onInbound(sink: (event: MessagingInboundEvent) => Promise<void>): void {
    this.sink = sink;
  }

  onCommand(commands: string[], handler: (command: MessagingCommand) => Promise<void>): void {
    this.chat.onSlashCommand(
      commands.map((command) => command.toLowerCase()),
      (event: SlashCommandEvent) => {
        const command = this.toCommand(event);
        if (!command || isRepeated(this.seenCommands, `${command.provider}:${command.handle}`)) {
          return;
        }
        // Acknowledge the webhook now (Slack allows three seconds); the
        // handler replies through the command's own response channel.
        const task = handler(command)
          .catch((error) => getLogger().error("slash command handler failed", error))
          .finally(() => this.pendingCommands.delete(task));
        this.pendingCommands.add(task);
      },
    );
  }

  /** Wait for slash command handlers still running (tests and shutdown). */
  async drainCommands(): Promise<void> {
    while (this.pendingCommands.size > 0) await Promise.all([...this.pendingCommands]);
  }

  onAction(actionIds: string[], handler: (action: MessagingAction) => Promise<void>): void {
    this.chat.onAction(actionIds, (event: ActionEvent) => {
      const action = this.toAction(event);
      if (!action || isRepeated(this.seenActions, `${action.provider}:${action.handle}`)) return;
      // Acknowledge the webhook now (Slack allows three seconds); the handler answers the
      // clicker through the action's own reply channel.
      const task = handler(action)
        .catch((error) => getLogger().error("card action handler failed", error))
        .finally(() => this.pendingActions.delete(task));
      this.pendingActions.add(task);
    });
  }

  /** Wait for card action handlers still running (tests and shutdown). */
  async drainActions(): Promise<void> {
    while (this.pendingActions.size > 0) await Promise.all([...this.pendingActions]);
  }

  cardProviders(): string[] {
    return CARD_PROVIDERS.filter((provider) => this.byProvider.has(provider));
  }

  async sendCard(
    threadId: string,
    card: MessagingCard,
    _context: AdapterContext,
  ): Promise<MessagingSendResult> {
    const provider = this.cardProvider(threadId);
    await this.ensureInitialized();
    const sent = await this.chat.thread(threadId).post(toChatCard(provider, card));
    const handle = "id" in sent && typeof sent.id === "string" ? sent.id : "";
    return { handle };
  }

  async updateCard(
    threadId: string,
    handle: string,
    card: MessagingCard,
    _context: AdapterContext,
  ): Promise<void> {
    const provider = this.cardProvider(threadId);
    await this.ensureInitialized();
    await this.byProvider
      .get(provider)!
      .adapter.editMessage(threadId, handle, toChatCard(provider, card));
  }

  private cardProvider(threadId: string): string {
    const provider = providerOfThreadId(threadId);
    if (!this.cardProviders().includes(provider)) {
      throw new Error(`${provider || "This provider"} cannot show cards`);
    }
    return provider;
  }

  handleWebhook(provider: string, request: Request): Promise<Response> | null {
    const platform = this.byProvider.get(provider);
    if (!platform) return null;
    return this.dispatchWebhook(platform, request);
  }

  async sendToThread(
    request: MessagingSendRequest,
    _context: AdapterContext,
  ): Promise<MessagingSendResult> {
    await this.ensureInitialized();
    // Bot replies are Markdown. A bare string posts as literal text, which
    // Slack shows with raw `**bold**` and `- lists`; a markdown message lets
    // every adapter render it natively (Slack markdown_text, Teams markdown
    // activities, plain text where the platform has no formatting).
    const sent = await this.chat.thread(request.threadId).post({ markdown: request.body });
    const handle = "id" in sent && typeof sent.id === "string" ? sent.id : "";
    return { handle };
  }

  async openDirectThread(
    provider: string,
    address: string,
    _context: AdapterContext,
  ): Promise<string> {
    const platform = this.byProvider.get(provider);
    if (!platform) throw new Error(`Unknown messaging provider: ${provider}`);
    if (platform.directThreadId) return platform.directThreadId(address);
    await this.ensureInitialized();
    if (!platform.adapter.openDM) {
      throw new Error(`${provider} cannot open direct conversations`);
    }
    return platform.adapter.openDM(address);
  }

  async sendTyping(threadId: string, context: AdapterContext): Promise<void> {
    const platform = this.byProvider.get(providerOfThreadId(threadId));
    if (!platform?.capabilities.typing) return;
    await this.ensureInitialized();
    // The Chat SDK adapter API takes no abort signal, so the underlying
    // request cannot be cancelled — but the caller's wait is still bounded.
    await raceWithSignal(platform.adapter.startTyping(threadId), context.signal);
  }

  /**
   * Proactively start the underlying Chat SDK instance. Webhook handling
   * and outbound sends already trigger this lazily (see ensureInitialized
   * below), but a polling-mode adapter (Telegram in "auto" mode with no
   * public webhook URL registered) needs its pull loop running before the
   * first inbound message can ever arrive, so long-running hosts call this
   * explicitly at startup instead of waiting on the first send.
   */
  async initialize(): Promise<void> {
    await this.ensureInitialized();
  }

  /**
   * Stop Telegram getUpdates before exit. Chat.shutdown() only calls
   * adapter.disconnect(), which Telegram does not implement.
   */
  async shutdown(): Promise<void> {
    const pending = this.initialized;
    this.initialized = undefined;
    if (pending) await pending.catch(() => undefined);
    await this.drainCommands();
    await this.drainActions();
    await this.stopPollingAdapters();
    const chat = this.chat as { shutdown?: () => Promise<void> };
    await chat.shutdown?.().catch(() => undefined);
  }

  private ensureInitialized(): Promise<void> {
    // Webhook handling initializes lazily inside the Chat SDK; proactive
    // sends from job runners need the explicit call. Chat keeps a rejected
    // initPromise until shutdown(), so clear that before allowing a retry.
    if (!this.initialized) {
      this.initialized = this.chat.initialize().catch(async (error) => {
        try {
          // Telegram may already be polling if Promise.all failed on another
          // adapter after Telegram's initialize started getUpdates.
          await this.stopPollingAdapters();
          await (this.chat as { shutdown?: () => Promise<void> }).shutdown?.();
        } catch {
          // Best-effort reset of Chat's cached init failure.
        } finally {
          this.initialized = undefined;
        }
        throw error;
      });
    }
    return this.initialized;
  }

  private async stopPollingAdapters(): Promise<void> {
    for (const platform of this.byProvider.values()) {
      const adapter = platform.adapter as { stopPolling?: () => Promise<void> };
      await adapter.stopPolling?.().catch(() => undefined);
    }
  }

  private async dispatchWebhook(platform: MessagingPlatform, request: Request): Promise<Response> {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MESSAGING_WEBHOOK_MAX_BODY_BYTES) {
      return new Response("Payload too large", { status: 413 });
    }
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? await readBoundedText(request, MESSAGING_WEBHOOK_MAX_BODY_BYTES) : "";
    if (body === null) {
      return new Response("Payload too large", { status: 413 });
    }
    const forwarded = hasBody
      ? new Request(request.url, { method: request.method, headers: request.headers, body })
      : request;
    // Real Chat SDK adapters fire processMessage without awaiting it; they
    // only register the work via waitUntil. Drain that work before ACKing so
    // a vendor 200 cannot race ahead of provision/enqueue, and surface sink
    // failures as 5xx so the vendor retries.
    const drain = { pending: [] as Promise<unknown>[], failed: false };
    const response = await webhookDrain.run(drain, async () => {
      const adapterResponse = await this.chat.webhooks[platform.provider]!(forwarded, {
        waitUntil: (task) => {
          drain.pending.push(task);
        },
      });
      await Promise.all(drain.pending);
      return adapterResponse;
    });
    if (drain.failed) {
      return new Response("Inbound processing failed", { status: 500 });
    }
    // Status peeking runs only after the adapter verified and accepted the
    // request — a forged webhook must not be able to flip outbox rows.
    if (platform.peekStatus && response.status < 300 && body) {
      const status = parseStatus(platform, body);
      if (status) await this.sink?.(status);
    }
    return response;
  }

  private toCommand(event: SlashCommandEvent): MessagingCommand | null {
    const platform = [...this.byProvider.values()].find((p) => p.adapter === event.adapter);
    if (!platform || event.user.isBot || event.user.isMe) return null;
    const provider = platform.provider;
    const raw = event.raw as Record<string, unknown> | null;
    const triggerId = typeof raw?.trigger_id === "string" ? raw.trigger_id : "";
    return {
      provider,
      command: event.command.toLowerCase(),
      text: event.text ?? "",
      from: event.user.userId,
      threadId: event.channel.id,
      handle: triggerId || `${event.user.userId}:${event.command}:${event.text}:${Date.now()}`,
      respond: async (body) => {
        if (platform.respondToCommand) {
          await platform.respondToCommand(event.raw, body);
          return;
        }
        await event.channel.postEphemeral(event.user, { markdown: body }, { fallbackToDM: true });
      },
    };
  }

  private toAction(event: ActionEvent): MessagingAction | null {
    const platform = [...this.byProvider.values()].find((p) => p.adapter === event.adapter);
    if (!platform || event.user.isBot || event.user.isMe) return null;
    if (!this.cardProviders().includes(platform.provider)) return null;
    const raw = (event.raw ?? {}) as Record<string, unknown>;
    // Slack: one trigger per click. Teams: the activity id of the invoke or submit.
    const interaction =
      platform.provider === "slack"
        ? stringField(raw.trigger_id) || slackActionTs(raw)
        : stringField(raw.id);
    if (!interaction || !event.user.userId) return null;
    const thread = event.thread;
    return {
      provider: platform.provider,
      actionId: event.actionId,
      value: event.value ?? "",
      from: event.user.userId,
      threadId: event.threadId,
      messageId: event.messageId,
      handle: interaction,
      respond: async (body) => {
        if (platform.respondToCommand) {
          await platform.respondToCommand(event.raw, body);
          return;
        }
        // Teams has no ephemeral messages; answer only inside a 1:1 chat.
        if (thread && platform.adapter.isDM?.(event.threadId)) {
          await thread.post({ markdown: body });
          return;
        }
        getLogger().warn("card action reply skipped outside a direct chat", {
          "messaging.provider": platform.provider,
        });
      },
    };
  }

  private toInbound(thread: Thread, message: Message): MessagingInboundMessage | null {
    if (message.author.isMe || message.author.isSystem) return null;
    const provider = providerOfThreadId(thread.id);
    const platform = this.byProvider.get(provider);
    if (!platform) return null;
    const isDirect = thread.isDM;
    if (!isDirect && !platform.capabilities.groups) return null;
    const fromLabel = message.author.fullName || message.author.userName || null;
    const transport = platform.transport?.(message.raw) ?? null;
    const base: MessagingInboundMessage = {
      type: "message",
      provider,
      ...(transport ? { transport } : {}),
      handle: message.id,
      threadId: thread.id,
      isDirect,
      from: message.author.userId,
      fromLabel: fromLabel === message.author.userId ? null : fromLabel,
      channelName: isDirect ? null : (platform.channelName?.(message.raw) ?? null),
      participants: isDirect ? [] : (platform.participants?.(message.raw) ?? []),
      content: message.text ?? "",
      mediaUrl: message.attachments.find((attachment) => attachment.url)?.url ?? null,
    };
    const enrichment = platform.enrichTeamRoom?.(message.raw, base) ?? {};
    return { ...base, ...enrichment };
  }
}

/** Remember per-invocation ids for a while so a repeated delivery is dropped. */
function isRepeated(seen: Map<string, number>, key: string): boolean {
  const now = Date.now();
  if (seen.size >= COMMAND_DEDUPE_MAX) {
    for (const [entry, at] of seen) {
      if (now - at > COMMAND_DEDUPE_MS) seen.delete(entry);
    }
    if (seen.size >= COMMAND_DEDUPE_MAX) seen.clear();
  }
  const previous = seen.get(key);
  if (previous !== undefined && now - previous <= COMMAND_DEDUPE_MS) return true;
  seen.set(key, now);
  return false;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function slackActionTs(raw: Record<string, unknown>): string {
  const actions = Array.isArray(raw.actions) ? (raw.actions as Array<{ action_ts?: unknown }>) : [];
  const ts = stringField(actions[0]?.action_ts);
  return ts ? `action:${ts}` : "";
}

export function providerOfThreadId(threadId: string): string {
  return threadId.split(":", 1)[0] ?? "";
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason ?? new Error("Aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      // The abandoned branch must not surface as an unhandled rejection.
      promise.catch(() => undefined);
      reject(signal.reason ?? new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Read the body incrementally so an unauthenticated chunked request (no
 * trustworthy Content-Length) is cut off at the cap instead of being
 * buffered whole. Returns null once the cap is exceeded.
 */
async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseStatus(platform: MessagingPlatform, body: string): MessagingOutboundStatus | null {
  try {
    return platform.peekStatus?.(JSON.parse(body)) ?? null;
  } catch {
    return null;
  }
}
