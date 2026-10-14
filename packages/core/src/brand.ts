/**
 * Product branding for white-label deployments. Each field resolves from the
 * deployment owner's runtime setting first, then PUBLIC_BRAND_* in the
 * environment, then the upstream product, so a deployment with neither is
 * unchanged. Only user- and model-visible copy follows the brand; package
 * names, env variables, logs and internal identifiers do not.
 */
export interface Brand {
  /** Product name in titles, headings, emails and chat replies. */
  name: string;
  /** Short name for the PWA manifest and home-screen icon label. */
  shortName: string;
  /** One-line description for the manifest and welcome screen. */
  tagline: string;
}

export const UPSTREAM_BRAND: Brand = {
  name: "Rakazo",
  shortName: "Rakazo",
  tagline: "Your team of always-on agents.",
};

export const UPSTREAM_REPOSITORY_URL = "https://github.com/elie222/rakazo";

export interface BrandEnv {
  PUBLIC_BRAND_NAME?: string | undefined;
  PUBLIC_BRAND_SHORT_NAME?: string | undefined;
  PUBLIC_BRAND_TAGLINE?: string | undefined;
}

/** Runtime values the deployment owner saved; null or blank falls back to the environment. */
export interface BrandOverrides {
  name?: string | null | undefined;
  shortName?: string | null | undefined;
  tagline?: string | null | undefined;
}

export function resolveBrand(env: BrandEnv = {}, overrides: BrandOverrides = {}): Brand {
  const name = clean(overrides.name) ?? clean(env.PUBLIC_BRAND_NAME) ?? UPSTREAM_BRAND.name;
  return {
    name,
    shortName: clean(overrides.shortName) ?? clean(env.PUBLIC_BRAND_SHORT_NAME) ?? name,
    tagline: clean(overrides.tagline) ?? clean(env.PUBLIC_BRAND_TAGLINE) ?? UPSTREAM_BRAND.tagline,
  };
}

/** True when the deployment presents itself under another name than upstream. */
export function isWhiteLabelled(brand: Pick<Brand, "name">): boolean {
  return brand.name !== UPSTREAM_BRAND.name;
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export const BRAND_TEXT_LIMITS = { name: 60, shortName: 60, tagline: 140 } as const;

export type BrandTextField = keyof typeof BRAND_TEXT_LIMITS;

/** A text update: a string sets the field, null or blank clears it, a missing key leaves it. */
export type BrandTextInput = Partial<Record<BrandTextField, string | null>>;

export type BrandTextValidation =
  | { ok: true; value: Partial<Record<BrandTextField, string | null>> }
  | { ok: false; field: BrandTextField; reason: "too_long" | "control_characters" };

// C0, DEL and C1 control characters, which include line breaks and tabs.
const CONTROL_CHARACTERS = /\p{Cc}/u;

export function validateBrandText(input: BrandTextInput): BrandTextValidation {
  const value: Partial<Record<BrandTextField, string | null>> = {};
  for (const field of Object.keys(BRAND_TEXT_LIMITS) as BrandTextField[]) {
    if (!(field in input) || input[field] === undefined) continue;
    const trimmed = input[field]?.trim() ?? "";
    if (!trimmed) {
      value[field] = null;
      continue;
    }
    if (CONTROL_CHARACTERS.test(trimmed)) return { ok: false, field, reason: "control_characters" };
    if ([...trimmed].length > BRAND_TEXT_LIMITS[field])
      return { ok: false, field, reason: "too_long" };
    value[field] = trimmed;
  }
  return { ok: true, value };
}

export interface BrandManifestIcon {
  src: string;
  sizes: string;
  type: string;
}

/** The icons upstream ships in apps/web/public. */
export const UPSTREAM_ICONS: BrandManifestIcon[] = [
  { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
  { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
];

/** The PWA manifest for a brand; upstream's when nothing is configured. */
export function brandManifest(brand: Brand, icons: BrandManifestIcon[] = UPSTREAM_ICONS) {
  return {
    name: brand.name,
    short_name: brand.shortName,
    description: brand.tagline,
    start_url: "/",
    display: "standalone",
    background_color: "#050506",
    theme_color: "#050506",
    icons,
  };
}

/**
 * A neutral square logo for a white-labelled deployment without an uploaded
 * one: the first letter of the name. Generated here, never from upload, and
 * the letter is XML-escaped, so the SVG carries no markup from the name.
 */
export function brandMonogramSvg(name: string): string {
  const first = [...name.trim()][0] ?? "";
  const letter = escapeXml(first.toLocaleUpperCase());
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">',
    '<rect width="512" height="512" rx="112" fill="#18181b"/>',
    '<text x="256" y="256" dy=".35em" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="280" font-weight="600" fill="#fafafa">',
    letter,
    "</text></svg>",
  ].join("");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
