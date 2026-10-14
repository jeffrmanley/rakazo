import { createHash } from "node:crypto";
import type { Brand, BrandEnv, BrandTextField } from "@rakazo/core";
import { resolveBrand } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import type { PrismaClient } from "./client.js";

/** Runtime branding on the deployment settings row, without the logo bytes. */
export interface BrandSettings {
  name: string | null;
  shortName: string | null;
  tagline: string | null;
  logoMime: string | null;
  logoSha256: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export interface StoredBrandLogo {
  bytes: Uint8Array;
  mime: string;
  sha256: string;
}

type BrandPrisma = Pick<PrismaClient, "deploymentSettings">;

const SETTINGS_ID = "default";

const BRAND_SELECT = {
  brandName: true,
  brandShortName: true,
  brandTagline: true,
  brandLogoMime: true,
  brandLogoSha256: true,
  brandUpdatedAt: true,
  brandUpdatedBy: true,
} as const;

type BrandRow = {
  brandName: string | null;
  brandShortName: string | null;
  brandTagline: string | null;
  brandLogoMime: string | null;
  brandLogoSha256: string | null;
  brandUpdatedAt: Date | null;
  brandUpdatedBy: string | null;
};

function toSettings(row: BrandRow | null): BrandSettings {
  return {
    name: row?.brandName ?? null,
    shortName: row?.brandShortName ?? null,
    tagline: row?.brandTagline ?? null,
    logoMime: row?.brandLogoMime ?? null,
    logoSha256: row?.brandLogoSha256 ?? null,
    updatedAt: row?.brandUpdatedAt ?? null,
    updatedBy: row?.brandUpdatedBy ?? null,
  };
}

export async function readBrandSettings(prisma: BrandPrisma): Promise<BrandSettings> {
  return toSettings(
    await prisma.deploymentSettings.findUnique({
      where: { id: SETTINGS_ID },
      select: BRAND_SELECT,
    }),
  );
}

export async function readBrandLogo(prisma: BrandPrisma): Promise<StoredBrandLogo | null> {
  const row = await prisma.deploymentSettings.findUnique({
    where: { id: SETTINGS_ID },
    select: { brandLogo: true, brandLogoMime: true, brandLogoSha256: true },
  });
  if (!row?.brandLogo || !row.brandLogoMime || !row.brandLogoSha256) return null;
  return { bytes: row.brandLogo, mime: row.brandLogoMime, sha256: row.brandLogoSha256 };
}

/**
 * Writes are conditional on `ownerUserId`, so only the deployment owner can
 * change the brand even if a caller skipped the service-layer check. Returns
 * null when `userId` is not the owner.
 */
async function writeAsOwner(
  prisma: BrandPrisma,
  userId: string,
  data: Record<string, unknown>,
): Promise<BrandSettings | null> {
  const { count } = await prisma.deploymentSettings.updateMany({
    where: { id: SETTINGS_ID, ownerUserId: userId },
    data: { ...data, brandUpdatedAt: new Date(), brandUpdatedBy: userId },
  });
  return count === 1 ? readBrandSettings(prisma) : null;
}

const TEXT_COLUMNS: Record<BrandTextField, keyof BrandRow> = {
  name: "brandName",
  shortName: "brandShortName",
  tagline: "brandTagline",
};

/** Validated text (see validateBrandText); a missing key leaves that field unchanged. */
export function saveBrandText(
  prisma: BrandPrisma,
  text: Partial<Record<BrandTextField, string | null>>,
  userId: string,
): Promise<BrandSettings | null> {
  const data: Record<string, string | null> = {};
  for (const [field, column] of Object.entries(TEXT_COLUMNS) as [BrandTextField, string][]) {
    if (text[field] !== undefined) data[column] = text[field];
  }
  return writeAsOwner(prisma, userId, data);
}

/** A logo that already passed inspectBrandLogo; the mime is the sniffed one. */
export function saveBrandLogo(
  prisma: BrandPrisma,
  logo: { bytes: Uint8Array; mime: string },
  userId: string,
): Promise<BrandSettings | null> {
  return writeAsOwner(prisma, userId, {
    brandLogo: new Uint8Array(logo.bytes),
    brandLogoMime: logo.mime,
    brandLogoSha256: createHash("sha256").update(logo.bytes).digest("hex"),
  });
}

export function removeBrandLogo(
  prisma: BrandPrisma,
  userId: string,
): Promise<BrandSettings | null> {
  return writeAsOwner(prisma, userId, {
    brandLogo: null,
    brandLogoMime: null,
    brandLogoSha256: null,
  });
}

export interface BrandReader {
  /** The resolved brand, cached for a short time so every email or reply does not query. */
  brand(): Promise<Brand>;
  name(): Promise<string>;
  /** Drop the cache after a change made in this process. */
  invalidate(): void;
}

const BRAND_CACHE_MS = 30_000;

/**
 * Resolves the brand (stored value, then PUBLIC_BRAND_*, then upstream) for
 * server-side copy: emails, chat replies, model catalog text and prompts.
 * Other processes pick a change up within the cache window. A read failure
 * falls back to the environment brand and is logged, never thrown, because
 * a product name must not take down a reply.
 */
export function createBrandReader(
  prisma: BrandPrisma,
  env: BrandEnv,
  options: { ttlMs?: number; now?: () => number } = {},
): BrandReader {
  const ttlMs = options.ttlMs ?? BRAND_CACHE_MS;
  const now = options.now ?? Date.now;
  let cached: { brand: Brand; at: number } | undefined;
  let pending: Promise<Brand> | undefined;
  let generation = 0;
  const load = async (): Promise<Brand> => {
    const started = generation;
    try {
      const settings = await readBrandSettings(prisma);
      const brand = resolveBrand(env, settings);
      if (started === generation) cached = { brand, at: now() };
      return brand;
    } catch (error) {
      getLogger().error("brand settings read failed; using the configured default", error);
      return resolveBrand(env);
    }
  };
  const brand = async () => {
    if (cached && now() - cached.at < ttlMs) return cached.brand;
    pending ??= load().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  return {
    brand,
    name: async () => (await brand()).name,
    invalidate: () => {
      generation += 1;
      cached = undefined;
      pending = undefined;
    },
  };
}
