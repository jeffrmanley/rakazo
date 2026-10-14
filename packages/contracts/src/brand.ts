import * as z from "zod";

/** Public brand for every client, `GET /api/v1/brand`. Works without a session. */
export const BrandViewSchema = z.object({
  name: z.string(),
  shortName: z.string(),
  tagline: z.string(),
  /** Versioned logo URL: the uploaded logo, a generated monogram, or upstream's icon. */
  logoUrl: z.string(),
  /** Versioned icon URL for the favicon and home-screen icon. */
  iconUrl: z.string(),
  /** Changes whenever the logo or brand text changes, for cache busting. */
  version: z.string(),
  /** True when the deployment owner uploaded a logo. */
  customLogo: z.boolean(),
});
export type BrandView = z.infer<typeof BrandViewSchema>;

/** The owner's view: the resolved brand plus the stored values, which may be unset. */
export const BrandSettingsSchema = z.object({
  brand: BrandViewSchema,
  stored: z.object({
    name: z.string().nullable(),
    shortName: z.string().nullable(),
    tagline: z.string().nullable(),
  }),
});
export type BrandSettings = z.infer<typeof BrandSettingsSchema>;

/**
 * Loose bounds only; the API validates trimmed lengths and characters. A
 * string sets a field, null or blank clears it, an absent key leaves it.
 */
const brandText = z.string().max(1_000).nullable().optional();
export const BrandTextUpdateSchema = z.object({
  name: brandText,
  shortName: brandText,
  tagline: brandText,
});

/** Base64 image bytes. The type is sniffed server-side; nothing declared is trusted. */
export const BrandLogoUploadSchema = z.object({ data: z.string().max(2_000_000) });

/** Why a brand update was refused, so clients can explain it in their own language. */
export const BRAND_ERROR_REASONS = [
  "name_too_long",
  "shortName_too_long",
  "tagline_too_long",
  "control_characters",
  "empty",
  "too_large",
  "unsupported_type",
  "corrupt",
  "dimensions",
] as const;
export type BrandErrorReason = (typeof BRAND_ERROR_REASONS)[number];
