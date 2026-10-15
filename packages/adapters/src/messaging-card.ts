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

/** Card emoji placeholders (`{{emoji:name}}`) are expanded by the adapters; keep them literal. */
function neutralizeEmojiPlaceholders(text: string): string {
  return text.replaceAll("{{", "{\u200b{");
}

/** Plain text inside a Slack code block: a fence in the text must not close the block. */
function slackCodeBlock(text: string): string {
  const body = escapeSlackMrkdwn(text).replaceAll("```", "`\u200b`\u200b`");
  return `\`\`\`\n${body}\n\`\`\``;
}

/**
 * Translate a provider-neutral card into a Chat SDK card for one platform. All card text is
 * plain; it is escaped here for the platform's markup, so nothing a model or a tool wrote
 * can mention people, add links or change formatting.
 */
export function toChatCard(provider: string, card: MessagingCard): CardElement {
  const slack = provider === "slack";
  const inline = (text: string) =>
    neutralizeEmojiPlaceholders(slack ? escapeSlackMrkdwn(text) : escapeTeamsMarkdown(text));
  const children: CardChild[] = card.blocks.map((block) => {
    if (block.kind === "code") {
      return CardText(
        neutralizeEmojiPlaceholders(
          slack ? slackCodeBlock(block.text) : escapeTeamsMarkdown(block.text),
        ),
      );
    }
    return CardText(inline(block.text), block.kind === "muted" ? { style: "muted" } : undefined);
  });
  if (card.actions?.length) {
    children.push(
      Actions(
        card.actions.map((action) =>
          Button({ id: action.id, label: action.label, value: action.value, style: action.style }),
        ),
      ),
    );
  }
  // Slack renders the title as a plain_text header; Teams renders it as markdown.
  return Card({
    title: slack ? neutralizeEmojiPlaceholders(card.title) : inline(card.title),
    children,
  });
}
