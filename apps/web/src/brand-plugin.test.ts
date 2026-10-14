import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrandView } from "@rakazo/contracts";
import { resolveBrand, UPSTREAM_BRAND } from "@rakazo/core";
import { describe, expect, it } from "vitest";
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
    expect(html).toContain('<meta name="description" content="Agents &lt;for> the crew." />');
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
    expect(html).toContain("<title>Acme &lt;/script>&lt;script>x()&lt;/script></title>");
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
  ): Promise<{ handled: boolean; status?: number; body?: string; type?: string }> {
    const handler = brandHtmlMiddleware(() => path.join(dir, "index.html"), source, resolveBrand());
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
      void handler({ url, method } as never, res as never, () => resolve({ handled: false }));
    });
  }

  it("serves index.html with the brand the API resolves, on first byte", async () => {
    const response = await request("/app/bot-1?x=1", async () =>
      view({ name: "Acme", shortName: "Acme" }),
    );
    expect(response).toMatchObject({ handled: true, status: 200 });
    expect(response.type).toBe("text/html; charset=utf-8");
    expect(response.body).toContain("<title>Acme</title>");
    expect(response.body).not.toContain("Rakazo");
  });

  it("leaves API, assets and well-known paths alone", async () => {
    const source = async () => view({ name: "Acme" });
    for (const url of [
      "/api/v1/brand",
      "/rpc/me",
      "/novnc/vnc.html",
      "/assets/index-abc.js",
      "/favicon.ico",
      "/.well-known/rakazo-desktop-stack",
    ]) {
      expect((await request(url, source)).handled, url).toBe(false);
    }
    expect((await request("/", source, "POST")).handled).toBe(false);
  });

  it("falls back to the configured brand when the API is unreachable", async () => {
    const response = await request("/", async () => null);
    expect(response.body).toContain("<title>Rakazo</title>");
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
