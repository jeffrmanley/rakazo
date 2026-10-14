import { resolveBrand, UPSTREAM_BRAND } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { brandManifest, brandPlugin } from "./brand-plugin.js";

const SHELL = [
  "<html><head>",
  '<meta name="description" content="Your team of always-on agents." />',
  '<meta name="apple-mobile-web-app-title" content="Rakazo" />',
  "<title>Rakazo</title>",
  "</head></html>",
].join("\n");

function transform(brand = resolveBrand()) {
  const plugin = brandPlugin(brand, undefined);
  const hook = plugin.transformIndexHtml as (html: string) => string;
  return hook(SHELL);
}

describe("brand plugin", () => {
  it("leaves the upstream shell untouched without configuration", () => {
    expect(transform()).toBe(SHELL);
    expect(JSON.parse(brandManifest(UPSTREAM_BRAND))).toMatchObject({
      name: "Rakazo",
      short_name: "Rakazo",
      description: "Your team of always-on agents.",
      icons: [{ src: "/icon-192.png" }, { src: "/icon-512.png" }],
    });
  });

  it("brands the title, meta tags and manifest, escaping attribute text", () => {
    const brand = resolveBrand({
      PUBLIC_BRAND_NAME: 'withJZ "Crew"',
      PUBLIC_BRAND_SHORT_NAME: "Crew",
      PUBLIC_BRAND_TAGLINE: "Agents <for> the crew.",
    });
    const html = transform(brand);
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
