import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrandView } from "@rakazo/contracts";
import { resolveBrand, UPSTREAM_BRAND } from "@rakazo/core";
import type { Plugin, PreviewServer } from "vite";
import { preview } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  brandHtml,
  brandHtmlMiddleware,
  brandManifest,
  brandPlugin,
  createRuntimeBrandSource,
} from "./brand-plugin.js";

const SHELL = [
  "<html><head>",
  '<meta name="description" content="Your team of always-on agents." />',
  '<meta name="apple-mobile-web-app-title" content="Rakazo" />',
  "<title>Rakazo</title>",
  "</head></html>",
].join("\n");

/** The build-time transform (no dev server in the hook context). */
function transform(brand = resolveBrand()) {
  const plugin = brandPlugin(brand, undefined, "http://api.test");
  const hook = plugin.transformIndexHtml as (html: string, ctx: object) => Promise<string>;
  return hook(SHELL, {});
}

describe("brand plugin", () => {
  it("leaves the upstream shell untouched without configuration", async () => {
    expect(await transform()).toBe(SHELL);
    expect(JSON.parse(brandManifest(UPSTREAM_BRAND))).toMatchObject({
      name: "Rakazo",
      short_name: "Rakazo",
      description: "Your team of always-on agents.",
      icons: [{ src: "/icon-192.png" }, { src: "/icon-512.png" }],
    });
  });

  it("brands the title, meta tags and manifest, escaping attribute text", async () => {
    const brand = resolveBrand({
      PUBLIC_BRAND_NAME: 'withJZ "Crew"',
      PUBLIC_BRAND_SHORT_NAME: "Crew",
      PUBLIC_BRAND_TAGLINE: "Agents <for> the crew.",
    });
    const html = await transform(brand);
    expect(html).toContain("<title>withJZ &quot;Crew&quot;</title>");
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Crew" />');
    expect(html).toContain('<meta name="description" content="Agents &lt;for&gt; the crew." />');
    expect(html).not.toContain("Rakazo");
    expect(JSON.parse(brandManifest(brand))).toMatchObject({
      name: 'withJZ "Crew"',
      short_name: "Crew",
      description: "Agents <for> the crew.",
    });
  });
});

const INDEX = [
  "<html><head>",
  '<meta name="description" content="Your team of always-on agents." />',
  '<meta name="apple-mobile-web-app-title" content="Rakazo" />',
  '<link rel="icon" href="/favicon.ico" sizes="any" />',
  '<link rel="icon" href="/favicon.png" type="image/png" sizes="128x128" />',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
  '<link rel="manifest" href="/site.webmanifest" />',
  "<title>Rakazo</title>",
  "</head><body></body></html>",
].join("\n");

const view = (overrides: Partial<BrandView> = {}): BrandView => ({
  ...UPSTREAM_BRAND,
  logoUrl: "/api/v1/brand/logo?v=abc",
  iconUrl: "/api/v1/brand/logo?v=abc",
  version: "abc",
  customLogo: false,
  ...overrides,
});

describe("runtime brand HTML", () => {
  it("keeps upstream links and only embeds the brand when nothing is configured", () => {
    const html = brandHtml(INDEX, view());
    expect(html).toContain('<link rel="manifest" href="/site.webmanifest" />');
    expect(html).toContain(
      '<link rel="icon" href="/favicon.png" type="image/png" sizes="128x128" />',
    );
    expect(html).toContain("<title>Rakazo</title>");
    expect(embeddedBrand(html)).toMatchObject({ name: "Rakazo", customLogo: false });
  });

  it("names the runtime brand and points icons and the manifest at the brand API", () => {
    const html = brandHtml(
      INDEX,
      view({ name: "Acme </script><script>x()</script>", shortName: "Acme", tagline: "Hi." }),
    );
    expect(html).not.toContain("Rakazo");
    expect(html).toContain("<title>Acme &lt;/script&gt;&lt;script&gt;x()&lt;/script&gt;</title>");
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Acme" />');
    expect(html).toContain('<meta name="description" content="Hi." />');
    expect(html.match(/rel="icon"/g)).toHaveLength(1);
    expect(html).toContain('<link rel="icon" href="/api/v1/brand/logo?v=abc" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/api/v1/brand/logo?v=abc" />');
    expect(html).toContain(
      '<link rel="manifest" href="/api/v1/brand/manifest.webmanifest?v=abc" />',
    );
    // The embedded JSON cannot close its script element.
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(embeddedBrand(html)?.name).toBe("Acme </script><script>x()</script>");
  });

  it("inserts brand text literally: replacement patterns and quotes cannot reshape the HTML", () => {
    const exploit = "0;url=https://evil.example$2 http-equiv=refresh x=$2";
    for (const text of ["$'", "$`", "$&", "$1", "$2", "$$", "$<name>", exploit, "a'b\"c>d"]) {
      const brand = view({ name: text, shortName: text, tagline: text, version: text });
      const html = brandHtml(INDEX, brand);
      const escaped = text
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      expect(html, text).toContain(`<title>${escaped}</title>`);
      expect(html, text).toContain(`<meta name="description" content="${escaped}" />`);
      expect(html, text).toContain(
        `<meta name="apple-mobile-web-app-title" content="${escaped}" />`,
      );
      // The exploit's text stays inside the quoted content value; no new attribute appears.
      expect(html, text).not.toMatch(/content="[^"]*"\s+http-equiv/);
      // Nothing duplicated or dropped around the replaced tags.
      expect(html.match(/<title>/g), text).toHaveLength(1);
      expect(html.match(/<meta /g), text).toHaveLength(2);
      expect(html.match(/<\/head>/g), text).toHaveLength(1);
      expect(html.endsWith("</head><body></body></html>"), text).toBe(true);
      expect(embeddedBrand(html)?.tagline, text).toBe(text);
    }
  });

  it("points at an uploaded logo even under the upstream name", () => {
    const html = brandHtml(INDEX, view({ customLogo: true }));
    expect(html).toContain('<link rel="icon" href="/api/v1/brand/logo?v=abc" />');
  });
});

function embeddedBrand(html: string): BrandView | null {
  const match = html.match(/<script type="application\/json" id="rakazo-brand">(.*?)<\/script>/s);
  return match ? (JSON.parse(match[1]!) as BrandView) : null;
}

describe("preview server", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "brand-preview-"));
  writeFileSync(path.join(dir, "index.html"), INDEX);

  async function request(
    url: string,
    source: () => Promise<BrandView | null>,
    method = "GET",
    indexPath = path.join(dir, "index.html"),
  ): Promise<{ handled: boolean; status?: number; body?: string; type?: string; error?: unknown }> {
    const handler = brandHtmlMiddleware(() => indexPath, source, resolveBrand());
    return new Promise((resolve) => {
      const headers: Record<string, string> = {};
      const res = {
        statusCode: 200,
        setHeader: (name: string, value: string) => {
          headers[name.toLowerCase()] = value;
        },
        end: (body: string) =>
          resolve({ handled: true, status: res.statusCode, body, type: headers["content-type"] }),
      };
      void handler({ url, method } as never, res as never, (error?: unknown) =>
        resolve({ handled: false, error }),
      );
    });
  }

  it("serves index.html with the brand the API resolves, on first byte", async () => {
    const response = await request("/index.html", async () =>
      view({ name: "Acme", shortName: "Acme" }),
    );
    expect(response).toMatchObject({ handled: true, status: 200 });
    expect(response.type).toBe("text/html; charset=utf-8");
    expect(response.body).toContain("<title>Acme</title>");
    expect(response.body).not.toContain("Rakazo");
  });

  it("answers only index.html: other routes stay with whoever serves them", async () => {
    const source = async () => view({ name: "Acme" });
    for (const url of [
      "/app/bot-1",
      "/api/v1/brand",
      "/rpc/me",
      "/novnc/vnc.html",
      "/assets/index-abc.js",
      "/favicon.ico",
      "/.well-known/rakazo-desktop-stack",
    ]) {
      expect((await request(url, source)).handled, url).toBe(false);
    }
    expect((await request("/index.html", source, "POST")).handled).toBe(false);
  });

  it("leaves a missing build to Vite instead of failing the request", async () => {
    const response = await request("/index.html", async () => null, "GET", path.join(dir, "no"));
    expect(response).toEqual({ handled: false, error: undefined });
  });

  it("falls back to the configured brand when the API is unreachable", async () => {
    const response = await request("/index.html", async () => null);
    expect(response.body).toContain("<title>Rakazo</title>");
  });
});

describe("Vite preview server with the brand plugin", () => {
  let api: Server;
  let apiOrigin: string;
  const servers: PreviewServer[] = [];

  beforeAll(async () => {
    api = createServer((req, res) => {
      if (req.url === "/api/v1/brand") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(view({ name: "Acme", shortName: "Acme" })));
      } else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    apiOrigin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.close()));
    await new Promise((resolve) => api.close(resolve));
  });

  /** A preview server for `root`, with a later plugin that owns `/screen` (like the screen proxy). */
  async function start(root: string) {
    const laterRoute: Plugin = {
      name: "later-route",
      configurePreviewServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/screen") return next();
          res.setHeader("content-type", "text/html");
          res.end("<title>Screen</title>");
        });
      },
    };
    const server = await preview({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [brandPlugin(resolveBrand(), undefined, apiOrigin), laterRoute],
      preview: { host: "127.0.0.1", port: 0 },
    });
    servers.push(server);
    const origin = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
    return (url: string) => fetch(`${origin}${url}`, { headers: { accept: "text/html" } });
  }

  it("brands every app page and leaves other plugins' routes untouched", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "brand-vite-"));
    mkdirSync(path.join(root, "dist"));
    writeFileSync(path.join(root, "dist", "index.html"), INDEX);
    const get = await start(root);
    for (const url of ["/", "/bots/abc?x=1", "/index.html"]) {
      const response = await get(url);
      expect(response.status, url).toBe(200);
      expect(await response.text(), url).toContain("<title>Acme</title>");
    }
    const screen = await get("/screen");
    expect(await screen.text()).toBe("<title>Screen</title>");
  });

  it("without a build, other routes still work and app pages are a plain 404", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "brand-vite-"));
    mkdirSync(path.join(root, "dist"));
    const get = await start(root);
    expect(await (await get("/screen")).text()).toBe("<title>Screen</title>");
    expect((await get("/bots/abc")).status).toBe(404);
  });
});

describe("runtime brand source", () => {
  it("caches the API brand and keeps the last good one when the API fails", async () => {
    let now = 0;
    let calls = 0;
    let fail = false;
    const source = createRuntimeBrandSource("http://api.test", {
      ttlMs: 1_000,
      now: () => now,
      fetch: async (url) => {
        calls += 1;
        expect(String(url)).toBe("http://api.test/api/v1/brand");
        if (fail) throw new Error("down");
        return Response.json(view({ name: "Acme" }));
      },
    });
    expect((await source())?.name).toBe("Acme");
    expect((await source())?.name).toBe("Acme");
    expect(calls).toBe(1);
    now = 2_000;
    fail = true;
    // Stale but white-labelled beats falling back to the upstream name.
    expect((await source())?.name).toBe("Acme");
    expect(calls).toBe(2);
  });

  it("returns null before the API has ever answered", async () => {
    const source = createRuntimeBrandSource("http://api.test", {
      fetch: async () => new Response("nope", { status: 502 }),
    });
    expect(await source()).toBeNull();
  });
});
