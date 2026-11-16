import { safeExternalUrl } from "./setup-config.js";

/** Only http(s) origins can be compared; data:, file: and about: have opaque "null" origins. */
export function httpOriginOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export type NavigationDecision = { allow: true } | { allow: false; external: string | null };

/**
 * The app window holds the privileged preload bridge, so its top frame may only stay on
 * the configured server origin. Applies to page-initiated navigations and to server
 * redirects alike; anything else goes to the system browser (http/https only).
 */
export function appNavigationDecision(
  targetUrl: string,
  navigationUrl: string,
): NavigationDecision {
  const target = httpOriginOf(targetUrl);
  if (target !== null && httpOriginOf(navigationUrl) === target) return { allow: true };
  return { allow: false, external: safeExternalUrl(navigationUrl) };
}

/**
 * Privileged IPC (browser sign-in, updater actions) is answered only while the sender's
 * top frame is on the server origin the window was opened for. A window that was somehow
 * moved to another origin keeps its bridge object, but the main process stops listening.
 */
export function isTrustedAppFrame(
  frameUrl: string | null | undefined,
  targetUrl: string | null | undefined,
): boolean {
  const target = httpOriginOf(targetUrl);
  return target !== null && httpOriginOf(frameUrl) === target;
}

/**
 * Sign-in popups load third-party provider pages without a preload. They never get to
 * spawn further Electron windows; any link they open goes to the system browser.
 */
export function popupWindowOpenTarget(url: string): string | null {
  return safeExternalUrl(url);
}
