import type { Brand } from "@rakazo/core";
import { isWhiteLabelled, resolveBrand, UPSTREAM_REPOSITORY_URL } from "@rakazo/core";

/**
 * Build-time branding (PUBLIC_BRAND_* in the environment Vite builds with).
 * Defaults to the upstream product; see docs/self-host.md "White-label".
 */
export const brand: Brand = resolveBrand({
  PUBLIC_BRAND_NAME: import.meta.env.PUBLIC_BRAND_NAME,
  PUBLIC_BRAND_SHORT_NAME: import.meta.env.PUBLIC_BRAND_SHORT_NAME,
  PUBLIC_BRAND_TAGLINE: import.meta.env.PUBLIC_BRAND_TAGLINE,
});

/** Shown only when the deployment runs under another name, as Apache-2.0 attribution. */
export const whiteLabelled = isWhiteLabelled(brand);

export const upstreamRepositoryUrl = UPSTREAM_REPOSITORY_URL;
