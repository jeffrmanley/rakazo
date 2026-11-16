/** The name this build shows its user. Internal identifiers (the rakazo:// scheme, module and
 * package names, storage keys, headers) keep the upstream name on purpose. */
export const APP_NAME = "withJZ Crew";

const UPSTREAM_NAME = /\bRakazo\b/g;

/**
 * Rebrands copy this app does not own: shared strings from @rakazo/core and @rakazo/contracts
 * that name the upstream product. Mobile's own strings already say APP_NAME.
 */
export function brandCopy(text: string): string {
  return text.replace(UPSTREAM_NAME, APP_NAME);
}
