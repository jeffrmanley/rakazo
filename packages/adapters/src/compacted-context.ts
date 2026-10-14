/**
 * Opens a compacted thread summary in the model context. It names no product,
 * so a white-labelled deployment shows the model none.
 */
export const COMPACTED_CONTEXT_PREFIX = "System-owned compacted context through message sequence";

/** The prefix written before runtime branding; still recognised in existing context. */
const LEGACY_COMPACTED_CONTEXT_PREFIX = "Rakazo-owned compacted context through message sequence";

export function isCompactedContextText(value: string): boolean {
  return (
    value.startsWith(`${COMPACTED_CONTEXT_PREFIX} `) ||
    value.startsWith(`${LEGACY_COMPACTED_CONTEXT_PREFIX} `)
  );
}
