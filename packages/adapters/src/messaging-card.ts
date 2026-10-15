import type { MessagingCard } from "@rakazo/adapter-kit";
import type { CardChild, CardElement } from "chat";
import { Actions, Button, Card, CardText } from "chat";

/** Platforms whose Chat SDK adapters render cards with buttons. */
export const CARD_PROVIDERS = ["slack", "teams"] as const;

/**
 * Slack mrkdwn treats `<…>` as mentions (`<!channel>`, `<@U1>`) and links (`<url|label>`);
 * Slack's own rule is to escape `&`, `<` and `>`, which makes all of them literal text.
 */
export function escapeSlackMrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Markdown punctuation Teams (Adaptive Card TextBlock) would read as formatting or links. */
const TEAMS_MARKDOWN = /[\\`*_{}[\]()#+\-.!|~<>]/g;

export function escapeTeamsMarkdown(text: string): string {
  return text.replace(TEAMS_MARKDOWN, (char) => `\\${char}`);
}

/**
 * Per-character Slack escaping, so a cut never splits an entity: the mrkdwn entities, and a
 * zero-width space after `{` (card emoji placeholders) and after a backtick (no text can
 * close the code fence it sits in).
 */
function escapeSlackChar(char: string): string {
  if (char === "{" || char === "`") return `${char}\u200b`;
  return escapeSlackMrkdwn(char);
}

/**
 * Size per section and for the whole card, in escaped characters. Slack rejects a section
 * over 3,000 characters (the adapter would cut it silently) and a message over 50 blocks;
 * an Adaptive Card must stay under about 28 KB.
 */
const PLATFORM_LIMITS = {
  slack: { section: 2_900, budget: 12_000 },
  teams: { section: 4_000, budget: 15_000 },
} as const;

/**
 * Translate a provider-neutral card into a Chat SDK card for one platform. All card text is
 * plain; it is escaped here for the platform's markup, so nothing a model or a tool wrote
 * can mention people, add links or change formatting. Text and code that do not fit the
 * platform are cut where the budget ends, never silently: the card says how many characters
 * are hidden and loses the actions its `overflow` names.
 */
export function toChatCard(provider: string, card: MessagingCard): CardElement {
  const slack = provider === "slack";
  const limits = slack ? PLATFORM_LIMITS.slack : PLATFORM_LIMITS.teams;
  const escapeChar = slack ? escapeSlackChar : escapeTeamsMarkdown;
  const escapeAll = (text: string) => Array.from(text, escapeChar).join("");
  const children: CardChild[] = [];
  let used = 0;
  let hidden = 0;
  for (const block of card.blocks) {
    if (block.kind === "muted") {
      children.push(CardText(escapeAll(block.text), { style: "muted" }));
      continue;
    }
    const code = block.kind === "code";
    const fence = slack && code ? 8 : 0;
    let piece = "";
    let pieceLength = 0;
    const flush = () => {
      if (!piece) return;
      children.push(CardText(slack && code ? `\`\`\`\n${piece}\n\`\`\`` : piece));
      piece = "";
      pieceLength = 0;
    };
    for (const char of block.text) {
      const escaped = escapeChar(char);
      if (hidden > 0 || used + escaped.length > limits.budget) {
        hidden += char.length;
        continue;
      }
      if (pieceLength + escaped.length + fence > limits.section) flush();
      piece += escaped;
      pieceLength += escaped.length;
      used += escaped.length;
    }
    flush();
  }
  let actions = card.actions ?? [];
  if (hidden > 0) {
    const notice = (card.overflow?.notice ?? "{hidden} characters hidden.").replace(
      "{hidden}",
      hidden.toLocaleString("en-US"),
    );
    children.push(CardText(escapeAll(notice), { style: "muted" }));
    const dropped = new Set(card.overflow?.dropActions ?? []);
    actions = actions.filter((action) => !dropped.has(action.id));
  }
  if (actions.length) {
    children.push(
      Actions(
        actions.map((action) =>
          Button({ id: action.id, label: action.label, value: action.value, style: action.style }),
        ),
      ),
    );
  }
  // Slack renders the title as a plain_text header; Teams renders it as markdown.
  return Card({
    title: slack ? card.title.replaceAll("{{", "{\u200b{") : escapeAll(card.title),
    children,
  });
}
