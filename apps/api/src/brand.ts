import { createHash, randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type {
  Actor,
  BrandErrorReason,
  BrandSettings as BrandSettingsDto,
  BrandView,
} from "@rakazo/contracts";
import type { Brand, BrandEnv, BrandManifestIcon, BrandTextInput } from "@rakazo/core";
import {
  brandManifest,
  brandMonogramSvg,
  inspectBrandLogo,
  isWhiteLabelled,
  resolveBrand,
  UPSTREAM_ICONS,
  validateBrandText,
} from "@rakazo/core";
import type { BrandReader, BrandSettings, PrismaClient, StoredBrandLogo } from "@rakazo/db";
import {
  createBrandReader,
  readBrandLogo,
  readBrandSettings,
  removeBrandLogo,
  saveBrandLogo,
  saveBrandText,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Context, Hono } from "hono";

export const BRAND_API_PATH = "/api/v1/brand";
/** The web app's own icon: upstream's, or the brand's when PUBLIC_BRAND_ASSETS_DIR replaced it. */
const STATIC_LOGO_PATH = "/icon-512.png";

export type BrandAction =
  | "brand.settings"
  | "brand.update"
  | "brand.uploadLogo"
  | "brand.removeLogo";

export type BrandResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: "forbidden" }
  | { ok: false; error: "invalid"; reason: BrandErrorReason };

export type BrandLogoAsset =
  | { kind: "image"; body: Uint8Array; mime: string; etag: string; version: string }
  | { kind: "static"; location: string };

export interface BrandService {
  /** Cached resolved brand for server-side copy (emails, chat replies, prompts). */
  reader: BrandReader;
  view(): Promise<BrandView>;
  logo(): Promise<BrandLogoAsset>;
  manifest(): Promise<ReturnType<typeof brandManifest>>;
  settings(actor: Actor | null): Promise<BrandResult<BrandSettingsDto>>;
  updateText(actor: Actor | null, input: BrandTextInput): Promise<BrandResult<BrandSettingsDto>>;
  uploadLogo(actor: Actor | null, input: { data: string }): Promise<BrandResult<BrandSettingsDto>>;
  removeLogo(actor: Actor | null): Promise<BrandResult<BrandSettingsDto>>;
}

type BrandPrisma = Pick<PrismaClient, "deploymentSettings">;

interface Snapshot {
  settings: BrandSettings;
  brand: Brand;
  view: BrandView;
}

const shortHash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

function versionOf(settings: BrandSettings, brand: Brand): string {
  if (settings.logoSha256) return settings.logoSha256.slice(0, 16);
  if (settings.updatedAt) return settings.updatedAt.getTime().toString(36);
  // Environment-only branding: changes with the configured name.
  return shortHash(brand.name);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const DATA_URL_PREFIX = /^data:[^,]*;base64,/;

function decodeBase64(data: string): Uint8Array | null {
  const body = data.replace(DATA_URL_PREFIX, "");
  if (body.length % 4 !== 0 || !BASE64.test(body)) return null;
  return new Uint8Array(Buffer.from(body, "base64"));
}

/**
 * Runtime white-label branding. Reading is public; every change is for the
 * deployment owner only (`DeploymentSettings.ownerUserId`), checked here and
 * again by the conditional write, and every refusal is logged.
 */
export function createBrandService(deps: {
  prisma: BrandPrisma;
  env: BrandEnv;
  /** PUBLIC_BRAND_ASSETS_DIR replaced the web app's icons, so they are the brand's, not upstream's. */
  assets?: boolean;
  reader?: BrandReader;
}): BrandService {
  const { prisma, env } = deps;
  /** Without an upload: a generated monogram, unless the web app already ships the brand's icons. */
  const usesMonogram = (brand: Brand) => isWhiteLabelled(brand) && !deps.assets;
  const reader = deps.reader ?? createBrandReader(prisma, env);
  let logoCache: StoredBrandLogo | undefined;

  const snapshot = async (): Promise<Snapshot> => {
    const settings = await readBrandSettings(prisma);
    const brand = resolveBrand(env, settings);
    const version = versionOf(settings, brand);
    const logoUrl = `${BRAND_API_PATH}/logo?v=${version}`;
    return {
      settings,
      brand,
      view: {
        ...brand,
        logoUrl,
        iconUrl: logoUrl,
        version,
        customLogo: Boolean(settings.logoSha256),
      },
    };
  };

  const storedLogo = async (sha256: string): Promise<StoredBrandLogo | null> => {
    if (logoCache?.sha256 === sha256) return logoCache;
    const logo = await readBrandLogo(prisma);
    if (logo) logoCache = logo;
    return logo;
  };

  const settingsDto = (current: Snapshot): BrandSettingsDto => ({
    brand: current.view,
    stored: {
      name: current.settings.name,
      shortName: current.settings.shortName,
      tagline: current.settings.tagline,
    },
  });

  const deny = (actor: Actor | null, action: BrandAction): BrandResult<never> => {
    getLogger().warn("brand change denied", {
      "user.id": actor?.userId ?? "anonymous",
      action,
    });
    return { ok: false, error: "forbidden" };
  };

  /** The actor when it is the deployment owner, else null. */
  const owner = async (actor: Actor | null): Promise<Actor | null> => {
    if (!actor) return null;
    const row = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true },
    });
    return row?.ownerUserId && row.ownerUserId === actor.userId ? actor : null;
  };

  /** The write repeats the owner condition, so ownership lost since the check is a denial too. */
  const commit = async (
    actor: Actor,
    action: BrandAction,
    write: (userId: string) => Promise<BrandSettings | null>,
  ): Promise<BrandResult<BrandSettingsDto>> => {
    const written = await write(actor.userId);
    if (!written) return deny(actor, action);
    reader.invalidate();
    return { ok: true, value: settingsDto(await snapshot()) };
  };

  return {
    reader,
    view: async () => (await snapshot()).view,

    logo: async () => {
      const current = await snapshot();
      const sha256 = current.settings.logoSha256;
      const logo = sha256 ? await storedLogo(sha256) : null;
      if (logo) {
        return {
          kind: "image",
          body: logo.bytes,
          mime: logo.mime,
          etag: `"${logo.sha256}"`,
          version: current.view.version,
        };
      }
      if (!usesMonogram(current.brand)) return { kind: "static", location: STATIC_LOGO_PATH };
      const svg = brandMonogramSvg(current.brand.name);
      return {
        kind: "image",
        body: new TextEncoder().encode(svg),
        mime: "image/svg+xml",
        etag: `"m-${shortHash(svg)}"`,
        version: current.view.version,
      };
    },

    manifest: async () => {
      const current = await snapshot();
      const src = current.view.logoUrl;
      let icons: BrandManifestIcon[] = UPSTREAM_ICONS;
      const sha256 = current.settings.logoSha256;
      const logo = sha256 ? await storedLogo(sha256) : null;
      if (logo) {
        const check = inspectBrandLogo(logo.bytes);
        const sizes = check.ok ? `${check.width}x${check.height}` : "any";
        icons = [{ src, sizes, type: logo.mime }];
      } else if (usesMonogram(current.brand)) {
        icons = [{ src, sizes: "any", type: "image/svg+xml" }];
      }
      return brandManifest(current.brand, icons);
    },

    settings: async (actor) => {
      if (!(await owner(actor))) return deny(actor, "brand.settings");
      return { ok: true, value: settingsDto(await snapshot()) };
    },

    updateText: async (actor, input) => {
      const ownerActor = await owner(actor);
      if (!ownerActor) return deny(actor, "brand.update");
      const checked = validateBrandText(input);
      if (!checked.ok) {
        const reason: BrandErrorReason =
          checked.reason === "too_long" ? `${checked.field}_too_long` : "control_characters";
        return { ok: false, error: "invalid", reason };
      }
      return commit(ownerActor, "brand.update", (userId) =>
        saveBrandText(prisma, checked.value, userId),
      );
    },

    uploadLogo: async (actor, input) => {
      const ownerActor = await owner(actor);
      if (!ownerActor) return deny(actor, "brand.uploadLogo");
      const bytes = decodeBase64(input.data);
      if (!bytes) return { ok: false, error: "invalid", reason: "corrupt" };
      // The type is whatever the bytes are; nothing the client declared is used.
      const check = inspectBrandLogo(bytes);
      if (!check.ok) return { ok: false, error: "invalid", reason: check.reason };
      return commit(ownerActor, "brand.uploadLogo", (userId) =>
        saveBrandLogo(prisma, { bytes, mime: check.mime }, userId),
      );
    },

    removeLogo: async (actor) => {
      const ownerActor = await owner(actor);
      if (!ownerActor) return deny(actor, "brand.removeLogo");
      return commit(ownerActor, "brand.removeLogo", (userId) => removeBrandLogo(prisma, userId));
    },
  };
}

const BRAND_ERROR_MESSAGES: Record<BrandErrorReason, string> = {
  name_too_long: "The name can be at most 60 characters.",
  shortName_too_long: "The short name can be at most 60 characters.",
  tagline_too_long: "The tagline can be at most 140 characters.",
  control_characters: "Use plain text without line breaks or control characters.",
  empty: "The image is empty.",
  too_large: "The image must be 1 MB or smaller.",
  unsupported_type: "Use a PNG, JPEG or WebP image.",
  corrupt: "The image could not be read.",
  dimensions: "The image must be 64 to 4096 pixels on each side.",
};

/**
 * Map a service result onto the RPC error contract: a generic FORBIDDEN, a
 * BAD_REQUEST that names the reason, or an internal error that carries only
 * an error id (details stay in the server log).
 */
export async function brandRpc<T>(run: () => Promise<BrandResult<T>>): Promise<T> {
  let result: BrandResult<T>;
  try {
    result = await run();
  } catch (error) {
    const errorId = randomUUID();
    getLogger().error("brand request failed", error, { "error.id": errorId });
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Internal error",
      data: { error_id: errorId },
    });
  }
  if (result.ok) return result.value;
  if (result.error === "forbidden") throw new ORPCError("FORBIDDEN");
  throw new ORPCError("BAD_REQUEST", {
    message: BRAND_ERROR_MESSAGES[result.reason],
    data: { reason: result.reason },
  });
}

const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Public, session-free reads: the brand, its logo and the PWA manifest.
 * Mounted outside /rpc, so no session middleware applies.
 */
export function mountBrandRoutes(app: Hono, brand: BrandService): void {
  const internalError = (c: Context, error: unknown) => {
    const errorId = randomUUID();
    getLogger().error("brand read failed", error, { "error.id": errorId });
    c.header("cache-control", "no-store");
    return c.json({ error: "Internal error", error_id: errorId }, 500);
  };

  app.get(BRAND_API_PATH, async (c) => {
    try {
      const view = await brand.view();
      c.header("cache-control", "no-cache");
      return c.json(view);
    } catch (error) {
      return internalError(c, error);
    }
  });

  app.get(`${BRAND_API_PATH}/logo`, async (c) => {
    let asset: BrandLogoAsset;
    try {
      asset = await brand.logo();
    } catch (error) {
      return internalError(c, error);
    }
    if (asset.kind === "static") {
      c.header("cache-control", "no-cache");
      return c.redirect(asset.location, 302);
    }
    const headers = {
      etag: asset.etag,
      "cache-control": c.req.query("v") === asset.version ? IMMUTABLE : "no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      "content-disposition": "inline",
    };
    if (c.req.header("if-none-match") === asset.etag) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(new Uint8Array(asset.body), {
      status: 200,
      headers: { ...headers, "content-type": asset.mime },
    });
  });

  app.get(`${BRAND_API_PATH}/manifest.webmanifest`, async (c) => {
    try {
      const manifest = await brand.manifest();
      return new Response(JSON.stringify(manifest, null, 2), {
        headers: {
          "content-type": "application/manifest+json",
          "cache-control": "no-cache",
        },
      });
    } catch (error) {
      return internalError(c, error);
    }
  });
}
