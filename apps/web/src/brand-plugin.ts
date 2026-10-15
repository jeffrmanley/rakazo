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

/** Escapes text for an HTML attribute or element body. */
const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * Replace the first match of `pattern`, keeping its first and last groups,
 * with `value` between them. A replacer function, never a replacement string,
 * so `$&`, `$1`, `` $` `` and the like in brand text stay literal.
 */
function replaceBetween(html: string, pattern: RegExp, value: string): string {
  return html.replace(pattern, (_match, before: string, after: string) => before + value + after);
}

/** Title and meta tags, as the build writes them. */
function brandText(html: string, brand: Pick<Brand, "name" | "shortName" | "tagline">): string {
  let out = replaceBetween(html, /(<title>)[^<]*(<\/title>)/, escapeHtml(brand.name));
  out = replaceBetween(
    out,
    /(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/,
    escapeHtml(brand.shortName),
  );
  return replaceBetween(
    out,
    /(<meta name="description" content=")[^"]*(")/,
    escapeHtml(brand.tagline),
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
    const icon = escapeHtml(view.iconUrl);
    let first = true;
    out = out.replace(/<link rel="icon"[^>]*>(\s*)/g, (_match, space: string) => {
      if (!first) return "";
      first = false;
      return `<link rel="icon" href="${icon}" />${space}`;
    });
    out = replaceBetween(out, /(<link rel="apple-touch-icon" href=")[^"]*(")/, icon);
    out = replaceBetween(
      out,
      /(<link rel="manifest" href=")[^"]*(")/,
      escapeHtml(`${BRAND_API_PATH}/manifest.webmanifest?v=${encodeURIComponent(view.version)}`),
    );
  }
  // JSON in a non-executed script; "<" and ">" are escaped so the data cannot close the element.
  const json = JSON.stringify(view).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  const script = `<script type="application/json" id="${EMBEDDED_BRAND_ID}">${json}</script>`;
  return out.replace("</head>", () => `${script}</head>`);
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

/** GET or HEAD of the built index.html: what Vite's SPA fallback turns every app navigation into. */
function isIndexRequest(method: string | undefined, url: string | undefined): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return (url ?? "").split("?", 1)[0] === "/index.html";
}

/**
 * Preview-server middleware: answers requests for index.html with the built
 * file under the runtime brand, so the first byte already carries it. Runs
 * after Vite's SPA fallback, so it only sees what Vite would answer with
 * index.html; every other route stays with whoever serves it.
 */
export function brandHtmlMiddleware(
  indexPath: () => string,
  source: () => Promise<BrandView | null>,
  fallback: Brand,
) {
  let template: string | undefined;
  return async (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => {
    if (!isIndexRequest(req.method, req.url)) {
      next();
      return;
    }
    try {
      template ??= await fs.promises.readFile(indexPath(), "utf8");
    } catch (error) {
      // Nothing built: Vite answers as it would without the brand (404).
      if ((error as NodeJS.ErrnoException).code === "ENOENT") next();
      else next(error);
      return;
    }
    try {
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
      const html = brandHtmlMiddleware(() => path.join(outDir, "index.html"), runtimeBrand, brand);
      // A direct /index.html request, before Vite's static files would serve it unbranded.
      server.middlewares.use(html);
      // App navigations once Vite's SPA fallback has rewritten them to /index.html: after
      // other plugins' routes (the screen proxy), the API proxy and static files.
      return () => {
        server.middlewares.use(html);
      };
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
