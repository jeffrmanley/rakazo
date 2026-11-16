/**
 * withJZ Crew desktop build settings (fork). Everything that differs from the
 * upstream Rakazo shell lives here so a merge from upstream has one place to check.
 */

/** User-visible product name. Internal identifiers (package names, env vars) stay "rakazo". */
export const PRODUCT_NAME = "withJZ Crew";

/** Matches electron-builder `appId`; Windows uses it to group taskbar entries and toasts. */
export const APP_USER_MODEL_ID = "com.withjz.crew.desktop";

/** The deployment this build is made for. Setup prefills it; any HTTPS server still works. */
export const DEFAULT_SERVER_URL = "https://eu-2.tail290516.ts.net";

/**
 * Upstream's update feed is the elie222/rakazo GitHub release list. Trusting it would let
 * upstream ship code to this PC, so the updater is not bundled and never runs. Turning it
 * back on needs a fork-owned feed and signed builds (see docs/desktop-windows.md).
 */
export const AUTO_UPDATE_ENABLED = false;

/**
 * The managed "This computer" stack pulls ghcr.io/elie222/rakazo images on mutable tags,
 * which is the same trust problem as the updater. It stays off in packaged builds until it
 * pulls fork-built, digest-pinned images. Unpackaged runs may opt in for the e2e suite.
 */
export function localStackEnabled(input: { packaged: boolean; env: NodeJS.ProcessEnv }): boolean {
  return !input.packaged && input.env.RAKAZO_ENABLE_LOCAL_STACK === "1";
}
