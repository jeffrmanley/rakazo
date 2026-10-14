import type { BrandView } from "@rakazo/contracts";
import type { Brand } from "@rakazo/core";
import { isWhiteLabelled, resolveBrand, UPSTREAM_BRAND } from "@rakazo/core";
import { useSyncExternalStore } from "react";

const BRAND_API_PATH = "/api/v1/brand";
/** Matches EMBEDDED_BRAND_ID in brand-plugin.ts: the brand the web server put in index.html. */
const EMBEDDED_BRAND_ID = "rakazo-brand";

/**
 * Build-time branding (PUBLIC_BRAND_* in the environment Vite builds with),
 * the fallback until the runtime brand is known. See docs/self-host.md.
 */
export const buildBrand: Brand = resolveBrand({
  PUBLIC_BRAND_NAME: import.meta.env.PUBLIC_BRAND_NAME,
  PUBLIC_BRAND_SHORT_NAME: import.meta.env.PUBLIC_BRAND_SHORT_NAME,
  PUBLIC_BRAND_TAGLINE: import.meta.env.PUBLIC_BRAND_TAGLINE,
});

function buildView(): BrandView {
  const logoUrl = `${BRAND_API_PATH}/logo`;
  return { ...buildBrand, logoUrl, iconUrl: logoUrl, version: "", customLogo: false };
}

function isBrandView(value: unknown): value is BrandView {
  const view = value as Partial<BrandView> | null;
  return (
    typeof view?.name === "string" &&
    typeof view.shortName === "string" &&
    typeof view.tagline === "string" &&
    typeof view.logoUrl === "string" &&
    typeof view.iconUrl === "string" &&
    typeof view.version === "string" &&
    typeof view.customLogo === "boolean"
  );
}

/** The brand the server embedded in index.html, so the first paint already shows it. */
function embeddedBrand(): BrandView | null {
  if (typeof document === "undefined") return null;
  const text = document.getElementById(EMBEDDED_BRAND_ID)?.textContent;
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isBrandView(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

let current: BrandView = embeddedBrand() ?? buildView();
const listeners = new Set<() => void>();

export function subscribeBrand(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const currentBrand = () => current;

/** The runtime brand: name, short name, tagline and logo for this deployment. */
export function useBrand(): BrandView {
  return useSyncExternalStore(subscribeBrand, currentBrand, currentBrand);
}

/** True when the welcome line should be the brand's own tagline instead of the localized upstream one. */
export function hasOwnTagline(brand: BrandView): boolean {
  return isWhiteLabelled(brand) || brand.tagline !== UPSTREAM_BRAND.tagline;
}

/** Whether favicons and the manifest come from the brand API instead of the static upstream files. */
export function usesBrandIcons(brand: BrandView): boolean {
  return brand.customLogo || isWhiteLabelled(brand);
}

export function setBrand(view: BrandView): void {
  current = view;
  applyBrandToDocument(view);
  for (const listener of listeners) listener();
}

/** Fetch the runtime brand; on failure the current one (embedded or build-time) stays. */
export async function refreshBrand(): Promise<void> {
  try {
    const response = await fetch(BRAND_API_PATH, { cache: "no-cache" });
    if (!response.ok) return;
    const view: unknown = await response.json();
    if (isBrandView(view)) setBrand(view);
  } catch {
    // Offline or the API is restarting: keep what is shown.
  }
}

function setAttribute(selector: string, name: string, value: string) {
  document.head.querySelector(selector)?.setAttribute(name, value);
}

/** Tab title, meta tags, favicon, home-screen icon and manifest for the runtime brand. */
export function applyBrandToDocument(view: BrandView): void {
  if (typeof document === "undefined") return;
  document.title = view.name;
  setAttribute('meta[name="apple-mobile-web-app-title"]', "content", view.shortName);
  setAttribute('meta[name="description"]', "content", view.tagline);
  if (!usesBrandIcons(view)) return;
  const icons = document.head.querySelectorAll('link[rel="icon"]');
  icons.forEach((link, index) => {
    if (index > 0) {
      link.remove();
      return;
    }
    link.removeAttribute("type");
    link.removeAttribute("sizes");
    link.setAttribute("href", view.iconUrl);
  });
  setAttribute('link[rel="apple-touch-icon"]', "href", view.iconUrl);
  setAttribute(
    'link[rel="manifest"]',
    "href",
    `${BRAND_API_PATH}/manifest.webmanifest?v=${encodeURIComponent(view.version)}`,
  );
}
