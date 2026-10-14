/**
 * Fork extension: emergency stop (EXT_EMERGENCY_STOP). Pure helpers shared by
 * the API (chat commands, the paused reply) and the worker.
 */

export interface ControlCommand {
  action: "stop" | "resume";
  /** Bot name as typed; null means the whole space. */
  botName: string | null;
}

const MAX_BOT_NAME = 100;
/** Slack `<@U123>`, Teams `<at>Name</at>`, or a plain `@name` before the command. */
const LEADING_MENTION = /^(?:<@[^>\s]+>|<at>[^<]*<\/at>|@[\w.-]+)\s*/i;
const COMMAND = /^\/(stop|resume)(?:[ \t]+([^\r\n]+))?$/i;

/**
 * `/stop`, `/stop <bot>`, `/resume <bot>` and `/resume`, optionally after a
 * mention of the bot account. Anything else (including a command buried in a
 * longer message) is ordinary text.
 */
export function parseControlCommand(text: string): ControlCommand | null {
  let rest = text.trim();
  for (let i = 0; i < 3; i += 1) {
    const mention = LEADING_MENTION.exec(rest);
    if (!mention) break;
    rest = rest.slice(mention[0].length);
  }
  const match = COMMAND.exec(rest.trim());
  if (!match) return null;
  const action = match[1]!.toLowerCase() as ControlCommand["action"];
  let name = match[2]?.trim() ?? "";
  if (name.length >= 2 && /^(["'“”]).*\1$|^“.*”$/.test(name)) name = name.slice(1, -1).trim();
  if (name.startsWith("@")) name = name.slice(1).trim();
  if (name.length > MAX_BOT_NAME) return null;
  return { action, botName: name || null };
}

/** The reply a stopped bot's chat sends get instead of a run, e.g. "Paused by Dana at 2026-10-15 09:05 UTC". */
export function formatPausedReply(stop: { name: string; at: Date }): string {
  const name = stop.name.trim() || "an owner";
  const at = stop.at.toISOString();
  return `Paused by ${name} at ${at.slice(0, 10)} ${at.slice(11, 16)} UTC`;
}
