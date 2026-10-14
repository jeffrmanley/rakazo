import fs from "node:fs";
import path from "node:path";
import type { Brand } from "@rakazo/core";
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

/** The PWA manifest for a brand; upstream values when nothing is configured. */
export function brandManifest(brand: Brand): string {
  return JSON.stringify(
    {
      name: brand.name,
      short_name: brand.shortName,
      description: brand.tagline,
      start_url: "/",
      display: "standalone",
      background_color: "#050506",
      theme_color: "#050506",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    },
    null,
    2,
  );
}

/**
 * Brand the static shell: tab title, meta tags, the PWA manifest and icons.
 * Defaults to the upstream product, so builds without PUBLIC_BRAND_* are
 * byte-for-byte what upstream ships. Runtime copy reads the same variables
 * through import.meta.env (envPrefix in vite.config.ts).
 */
export function brandPlugin(brand: Brand, assetsDir: string | undefined): Plugin {
  const manifest = brandManifest(brand);
  const assetPath = (file: string) => (assetsDir ? path.join(assetsDir, file) : undefined);
  const brandAsset = (file: string) => {
    const candidate = assetPath(file);
    return candidate && fs.existsSync(candidate) ? candidate : undefined;
  };
  const serve = (server: ViteDevServer | PreviewServer) => {
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
  const escapeAttribute = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return {
    name: "rakazo-brand",
    transformIndexHtml(html) {
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
    },
    configureServer: serve,
    configurePreviewServer: serve,
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
