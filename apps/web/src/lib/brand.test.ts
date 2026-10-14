// @vitest-environment jsdom
import type { BrandView } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HEAD = [
  '<meta name="description" content="Your team of always-on agents." />',
  '<meta name="apple-mobile-web-app-title" content="Rakazo" />',
  '<link rel="icon" href="/favicon.ico" sizes="any" />',
  '<link rel="icon" href="/favicon.png" type="image/png" sizes="128x128" />',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
  '<link rel="manifest" href="/site.webmanifest" />',
  "<title>Rakazo</title>",
].join("");

const acme: BrandView = {
  name: "Acme Crew",
  shortName: "Crew",
  tagline: "Agents for Acme.",
  logoUrl: "/api/v1/brand/logo?v=v1",
  iconUrl: "/api/v1/brand/logo?v=v1",
  version: "v1",
  customLogo: true,
};

async function load() {
  vi.resetModules();
  return import("./brand");
}

beforeEach(() => {
  document.head.innerHTML = HEAD;
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.getElementById("rakazo-brand")?.remove();
});

describe("runtime brand", () => {
  it("starts from the brand the server embedded in index.html", async () => {
    const script = document.createElement("script");
    script.type = "application/json";
    script.id = "rakazo-brand";
    script.textContent = JSON.stringify(acme);
    document.head.append(script);
    const { currentBrand } = await load();
    expect(currentBrand()).toEqual(acme);
  });

  it("falls back to the build-time brand and ignores malformed embedded data", async () => {
    const script = document.createElement("script");
    script.type = "application/json";
    script.id = "rakazo-brand";
    script.textContent = '{"name": 1}';
    document.head.append(script);
    const { buildBrand, currentBrand } = await load();
    expect(currentBrand().name).toBe(buildBrand.name);
  });

  it("applies the brand to the title, meta tags, icons and manifest", async () => {
    const { applyBrandToDocument } = await load();
    applyBrandToDocument(acme);
    expect(document.title).toBe("Acme Crew");
    expect(
      document.head
        .querySelector('meta[name="apple-mobile-web-app-title"]')
        ?.getAttribute("content"),
    ).toBe("Crew");
    const icons = document.head.querySelectorAll('link[rel="icon"]');
    expect(icons).toHaveLength(1);
    expect(icons[0]?.getAttribute("href")).toBe("/api/v1/brand/logo?v=v1");
    expect(icons[0]?.hasAttribute("type")).toBe(false);
    expect(document.head.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href")).toBe(
      "/api/v1/brand/logo?v=v1",
    );
    expect(document.head.querySelector('link[rel="manifest"]')?.getAttribute("href")).toBe(
      "/api/v1/brand/manifest.webmanifest?v=v1",
    );
  });

  it("keeps the upstream icons when nothing is configured", async () => {
    const { applyBrandToDocument } = await load();
    applyBrandToDocument({
      ...acme,
      name: "Rakazo",
      shortName: "Rakazo",
      tagline: "Your team of always-on agents.",
      customLogo: false,
    });
    expect(document.head.querySelectorAll('link[rel="icon"]')).toHaveLength(2);
    expect(document.head.querySelector('link[rel="manifest"]')?.getAttribute("href")).toBe(
      "/site.webmanifest",
    );
  });

  it("refreshes from the API and notifies subscribers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(acme)),
    );
    const { refreshBrand, currentBrand, subscribeBrand } = await load();
    const listener = vi.fn();
    subscribeBrand(listener);
    await refreshBrand();
    expect(currentBrand()).toEqual(acme);
    expect(listener).toHaveBeenCalled();
    expect(document.title).toBe("Acme Crew");
  });

  it("keeps the current brand when the API fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    const { refreshBrand, currentBrand, buildBrand } = await load();
    await refreshBrand();
    expect(currentBrand().name).toBe(buildBrand.name);
  });
});
