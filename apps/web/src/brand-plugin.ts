import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { BrandView } from "@rakazo/contracts";
// The subpath, not the package root: vite.config.ts loads this file in Node, which cannot
// load the root barrel's TypeScript sources.
import type { Brand } from "@rakazo/core/brand";
import { isWhiteLabelled, brandManifest as manifestFor } from "@rakazo/core/brand";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";

/** Favicons and PWA icons a white-label build may replace from PUBLIC_BRAND_ASSETS_DIR. */
export const BRAND_ASSET_FILES = [
  "favicon.ico",
  "favicon.png",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
];

/** The build-time PWA manifest for a brand; upstream values when nothing is configured. */
export function brandManifest(brand: Brand): string {
  return JSON.stringify(manifestFor(brand), null, 2);
}

const BRAND_API_PATH = "/api/v1/brand";
/** Element id of the brand JSON the server embeds, read by lib/brand.ts before first render. */
export const EMBEDDED_BRAND_ID = "rakazo-brand";

const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Title and meta tags, as the build writes them. */
function brandText(html: string, brand: Pick<Brand, "name" | "shortName" | "tagline">): string {
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeAttribute(brand.name)}</title>`)
    .replace(
      /(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/,
      `$1${escapeAttribute(brand.shortName)}$2`,
    )
    .replace(
      /(<meta name="description" content=")[^"]*(")/,
      `$1${escapeAttribute(brand.tagline)}$2`,
    );
}

/**
 * index.html under the runtime brand: title, meta, and (for a white-labelled
 * deployment or an uploaded logo) favicon, home-screen icon and manifest
 * links that point at the brand API. The brand is embedded as JSON so the
 * app renders it on first paint without waiting for a request.
 */
export function brandHtml(html: string, view: BrandView): string {
  let out = brandText(html, view);
  if (view.customLogo || isWhiteLabelled(view)) {
    const icon = escapeAttribute(view.iconUrl);
    let first = true;
    out = out
      .replace(/<link rel="icon"[^>]*>(\s*)/g, (_match, space: string) => {
        if (!first) return "";
        first = false;
        return `<link rel="icon" href="${icon}" />${space}`;
      })
      .replace(/(<link rel="apple-touch-icon" href=")[^"]*(")/, `$1${icon}$2`)
      .replace(
        /(<link rel="manifest" href=")[^"]*(")/,
        `$1${BRAND_API_PATH}/manifest.webmanifest?v=${encodeURIComponent(view.version)}$2`,
      );
  }
  // JSON in a non-executed script; "<" is escaped so the data cannot close the element.
  const json = JSON.stringify(view).replace(/</g, "\\u003c");
  return out.replace(
    "</head>",
    `<script type="application/json" id="${EMBEDDED_BRAND_ID}">${json}</script></head>`,
  );
}

/** The brand view a server falls back to when the API cannot be asked. */
export function fallbackBrandView(brand: Brand): BrandView {
  const logoUrl = `${BRAND_API_PATH}/logo`;
  return { ...brand, logoUrl, iconUrl: logoUrl, version: "", customLogo: false };
}

/**
 * Reads the resolved brand from the API (`GET /api/v1/brand`) for HTML the
 * web server renders. Cached briefly; when the API fails the last answer is
 * kept, so a white-labelled deployment never falls back to the upstream name
 * once it has been seen. Null only before the first successful answer.
 */
export function createRuntimeBrandSource(
  apiOrigin: string,
  options: {
    ttlMs?: number;
    timeoutMs?: number;
    now?: () => number;
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  } = {},
): () => Promise<BrandView | null> {
  const ttlMs = options.ttlMs ?? 5_000;
  const now = options.now ?? Date.now;
  const fetchBrand = options.fetch ?? fetch;
  let last: { view: BrandView; at: number } | undefined;
  let pending: Promise<BrandView | null> | undefined;
  const load = async () => {
    try {
      const response = await fetchBrand(new URL(BRAND_API_PATH, apiOrigin).href, {
        signal: AbortSignal.timeout(options.timeoutMs ?? 1_500),
      });
      if (!response.ok) return last?.view ?? null;
      const view = (await response.json()) as BrandView;
      if (typeof view?.name !== "string") return last?.view ?? null;
      last = { view, at: now() };
      return view;
    } catch {
      // The API may still be starting; serve what was last known.
      return last?.view ?? null;
    }
  };
  return async () => {
    if (last && now() - last.at < ttlMs) return last.view;
    pending ??= load().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

const SERVER_PREFIXES = ["/api/", "/rpc/", "/novnc/", "/.well-known/", "/@", "/__"];

/** A navigation the SPA answers with index.html: GET or HEAD, no file extension, not a server path. */
function isDocumentRequest(method: string | undefined, url: string | undefined): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const pathname = (url ?? "/").split("?", 1)[0]!;
  if (pathname === "/api" || pathname === "/rpc") return false;
  if (SERVER_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !last.includes(".") || last === "index.html";
}

/**
 * Preview-server middleware: answers document requests with the built
 * index.html under the runtime brand, so the first byte already carries it.
 */
export function brandHtmlMiddleware(
  indexPath: () => string,
  source: () => Promise<BrandView | null>,
  fallback: Brand,
) {
  let template: string | undefined;
  return async (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => {
    if (!isDocumentRequest(req.method, req.url)) {
      next();
      return;
    }
    try {
      template ??= await fs.promises.readFile(indexPath(), "utf8");
      const view = (await source()) ?? fallbackBrandView(fallback);
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-cache");
      res.end(req.method === "HEAD" ? "" : brandHtml(template, view));
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Brand the static shell: tab title, meta tags, the PWA manifest and icons.
 * The build uses PUBLIC_BRAND_* (upstream values when unset, so the output
 * is what upstream ships). The dev and preview servers then serve every
 * document under the runtime brand the API resolves (`apiOrigin`), so the
 * owner's branding reaches the first byte without a rebuild.
 */
export function brandPlugin(
  brand: Brand,
  assetsDir: string | undefined,
  apiOrigin?: string,
): Plugin {
  const manifest = brandManifest(brand);
  const runtimeBrand = apiOrigin ? createRuntimeBrandSource(apiOrigin) : async () => null;
  const assetPath = (file: string) => (assetsDir ? path.join(assetsDir, file) : undefined);
  const brandAsset = (file: string) => {
    const candidate = assetPath(file);
    return candidate && fs.existsSync(candidate) ? candidate : undefined;
  };
  const serveAssets = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use((req, res, next) => {
      const pathname = req.url?.split("?", 1)[0] ?? "/";
      if (pathname === "/site.webmanifest") {
        res.setHeader("content-type", "application/manifest+json");
        res.end(manifest);
        return;
      }
      const file = BRAND_ASSET_FILES.find((name) => pathname === `/${name}`);
      const replacement = file ? brandAsset(file) : undefined;
      if (!replacement) {
        next();
        return;
      }
      res.setHeader("content-type", file!.endsWith(".ico") ? "image/x-icon" : "image/png");
      fs.createReadStream(replacement).pipe(res);
    });
  };
  return {
    name: "rakazo-brand",
    async transformIndexHtml(html, ctx) {
      // Build: the configured brand only. Dev server: per request, the runtime brand.
      if (!ctx?.server) return brandText(html, brand);
      return brandHtml(html, (await runtimeBrand()) ?? fallbackBrandView(brand));
    },
    configureServer: serveAssets,
    configurePreviewServer(server) {
      serveAssets(server);
      const outDir = path.resolve(server.config.root, server.config.build.outDir);
      server.middlewares.use(
        brandHtmlMiddleware(() => path.join(outDir, "index.html"), runtimeBrand, brand),
      );
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "site.webmanifest", source: manifest });
    },
    writeBundle(options) {
      const outDir = options.dir ?? path.resolve(import.meta.dirname, "dist");
      for (const file of BRAND_ASSET_FILES) {
        const replacement = brandAsset(file);
        if (replacement) fs.copyFileSync(replacement, path.join(outDir, file));
      }
    },
  };
}
