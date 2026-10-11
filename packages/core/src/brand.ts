/**
 * Product branding for white-label deployments. Every value defaults to the
 * upstream product, so a deployment without PUBLIC_BRAND_* set is unchanged.
 * Only user-visible copy follows the brand; package names, env variables,
 * logs and internal identifiers do not.
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

export function resolveBrand(env: BrandEnv = {}): Brand {
  const name = clean(env.PUBLIC_BRAND_NAME) ?? UPSTREAM_BRAND.name;
  return {
    name,
    shortName: clean(env.PUBLIC_BRAND_SHORT_NAME) ?? name,
    tagline: clean(env.PUBLIC_BRAND_TAGLINE) ?? UPSTREAM_BRAND.tagline,
  };
}

/** True when the deployment presents itself under another name than upstream. */
export function isWhiteLabelled(brand: Pick<Brand, "name">): boolean {
  return brand.name !== UPSTREAM_BRAND.name;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
