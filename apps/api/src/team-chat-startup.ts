import type { MessagingInboundMessage } from "@rakazo/adapter-kit";

/** Cap buffered TeamChat events while the bridge is still starting. */
export const PENDING_TEAM_CHAT_LIMIT = 100;

/** Bound how long shutdown waits for an in-flight TeamChatBridge.start(). */
export const TEAM_CHAT_STARTUP_SHUTDOWN_MS = 2_000;

/** Durable claim while wakeMessageRoutines may still be writing its wake nonce. */
export const MESSAGE_ROUTING_REASON = "message_routine_routing";
/** One-shot grace claim; a second expiry promotes to agent delivery. */
export const MESSAGE_ROUTING_REARMED_REASON = "message_routine_routing_rearmed";
/** Exclusive claim while TeamChat is creating the fallback agent run. */
export const TEAMCHAT_AGENT_OWNERSHIP_REASON = "message_teamchat_agent";
/** Hold deferred rows while a TeamChat wake may still create its run. */
export const MESSAGE_ROUTING_RESERVATION_MS = 30 * 60_000;

/**
 * Slack (and its emulator) hand every message to the team-chat bot once one
 * is configured. Other platforms join per room: Teams group chats and
 * channels carry a workspace id while 1:1 chats stay on the personal line.
 */
export function prefersTeamChatSurface(
  event: Pick<MessagingInboundMessage, "provider" | "workspaceId">,
  teamChatBotId: string | undefined | null,
): boolean {
  return (
    Boolean(teamChatBotId) &&
    (event.provider === "slack" ||
      event.provider === "teamchat-emulator" ||
      Boolean(event.workspaceId))
  );
}

/** Providers that get their own TeamChatBridge: one per platform whose rooms are team rooms. */
export function teamChatProviders(
  platforms: Array<{ provider: string; capabilities: { teamChat?: boolean } }>,
): string[] {
  return platforms.filter((platform) => platform.capabilities.teamChat).map((p) => p.provider);
}

/** Queue TeamChat-shaped messages until TeamChatBridge.receive is available. */
export class PendingTeamChatInbound {
  private events: Array<{
    event: MessagingInboundMessage;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(private readonly limit = PENDING_TEAM_CHAT_LIMIT) {}

  get size(): number {
    return this.events.length;
  }

  enqueue(event: MessagingInboundMessage): Promise<void> | null {
    if (this.events.length >= this.limit) return null;
    return new Promise<void>((resolve, reject) => {
      this.events.push({ event, resolve, reject });
    });
  }

  /** Hand queued events to a ready bridge; with `select`, only the matching ones. */
  flush(
    handle: (event: MessagingInboundMessage) => Promise<void>,
    select: (event: MessagingInboundMessage) => boolean = () => true,
  ): void {
    const ready = this.events.filter((pending) => select(pending.event));
    this.events = this.events.filter((pending) => !select(pending.event));
    for (const pending of ready) {
      void handle(pending.event).then(pending.resolve, pending.reject);
    }
  }

  reject(error: unknown): void {
    for (const pending of this.events.splice(0, this.events.length)) {
      pending.reject(error);
    }
  }
}

export function settleWithTimeout(
  task: Promise<unknown> | undefined,
  timeoutMs: number,
): Promise<"done" | "timeout"> {
  if (!task) return Promise.resolve("done");
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task.then(
      () => "done" as const,
      () => "done" as const,
    ),
    new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
