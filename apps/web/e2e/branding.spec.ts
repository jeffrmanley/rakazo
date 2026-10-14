import { deflateSync } from "node:zlib";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { BRAND_NAME, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

const UPSTREAM = "Rakazo";
const buildWhiteLabelled = BRAND_NAME !== UPSTREAM;
/**
 * The runtime-branding journey changes the deployment's brand, so it needs a
 * fresh database where its first sign-up owns the deployment and nothing runs
 * beside it: BRAND_E2E_OWNER=1 pnpm test:e2e -- --spec=e2e/branding.spec.ts
 */
const ownerRun = process.env.BRAND_E2E_OWNER === "1";

/** Visible text of the page. Nothing is excluded: the upstream name appears nowhere. */
async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

/** The manifest the page links to (static upstream file or the brand API). */
async function linkedManifest(page: Page): Promise<{ name: string; short_name: string }> {
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  const response = await page.request.get(href ?? "/site.webmanifest");
  expect(response.ok()).toBe(true);
  return (await response.json()) as { name: string; short_name: string };
}

/** What browsers surface outside the page body: tab title, manifest and the served HTML. */
async function chromeText(page: Page): Promise<string> {
  const manifest = await linkedManifest(page);
  const path = new URL(page.url()).pathname;
  const html = await (await page.request.get(path, { headers: { accept: "text/html" } })).text();
  return [await page.title(), manifest.name, manifest.short_name, html].join("\n");
}

/** Sign up while the deployment runs under `brandName` (helpers.signup expects the build's brand). */
async function signupUnder(page: Page, brandName: string, email: string, name: string) {
  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { name: `Create your ${brandName}` })).toBeVisible();
  await page.getByPlaceholder("Your name").fill(name);
  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByPlaceholder("Password").fill("password12");
  await page.getByRole("button", { name: "Create account" }).click();
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A small, valid, solid-colour RGB PNG. */
function tinyPng(size: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x3c)]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test.describe
  .serial("runtime branding", () => {
    test.skip(!ownerRun, "Needs BRAND_E2E_OWNER=1 on a fresh database (see the comment above)");

    const brand = { name: "Acme Crew", shortName: "Crew", tagline: "Agents for Acme." };
    let owner: BrowserContext;
    let ownerPage: Page;

    test.beforeAll(async ({ browser }) => {
      owner = await browser.newContext();
      ownerPage = await owner.newPage();
    });

    test.afterAll(async () => {
      // Leave the deployment as upstream for anything that runs after this file.
      await rpc(ownerPage, "brand/update", { name: null, shortName: null, tagline: null }).catch(
        () => undefined,
      );
      await rpc(ownerPage, "brand/removeLogo", null).catch(() => undefined);
      // The web server caches the API's brand for a few seconds; wait until it serves the reset one.
      await expect
        .poll(async () =>
          (await ownerPage.request.get("/", { headers: { accept: "text/html" } })).text(),
        )
        .toContain(`<title>${BRAND_NAME}</title>`);
      await owner.close();
    });

    test("the owner rebrands the running deployment without a rebuild", async () => {
      const page = ownerPage;
      const stamp = Date.now();
      await signup(page, `brand-owner-${stamp}@rakazo.test`, "password12", `Owner ${stamp}`);
      await completeOnboarding(page);
      const me = await rpc<{ isDeploymentOwner: boolean }>(page, "me", null);
      expect(me.isDeploymentOwner, "the first sign-up on a fresh database owns it").toBe(true);

      const settings = await openUserSettings(page, "branding");
      const panel = settings.getByTestId("branding-settings");
      await panel.getByLabel("Name", { exact: true }).fill(brand.name);
      await panel.getByLabel("Short name").fill(brand.shortName);
      await panel.getByLabel("Tagline").fill(brand.tagline);
      await panel.getByTestId("branding-logo-input").setInputFiles({
        name: "logo.png",
        mimeType: "image/png",
        buffer: tinyPng(96),
      });
      await expect(panel.getByTestId("branding-logo-preview")).toHaveAttribute("src", /^blob:/);
      await panel.getByRole("button", { name: "Save", exact: true }).click();
      await expect(panel.getByText("Saved")).toBeVisible();
      // The running app follows at once.
      await expect(page).toHaveTitle(brand.name);

      await page.reload();
      await expect(page).toHaveTitle(brand.name);
      const logo = page.getByTestId("bots-sidebar").getByTestId("brand-logo");
      await expect(logo).toHaveAttribute("src", /^\/api\/v1\/brand\/logo\?v=[0-9a-f]{16}$/);
      await expect
        .poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth))
        .toBe(96);
      expect(await linkedManifest(page)).toMatchObject({
        name: brand.name,
        short_name: brand.shortName,
      });
      const icon = await page.locator('link[rel="icon"]').getAttribute("href");
      expect(icon).toMatch(/^\/api\/v1\/brand\/logo\?v=/);
      const served = await (
        await page.request.get("/", { headers: { accept: "text/html" } })
      ).text();
      expect(served).toContain(`<title>${brand.name}</title>`);
      expect(served).not.toContain(UPSTREAM);

      const logoResponse = await page.request.get(icon!);
      expect(logoResponse.headers()["content-type"]).toBe("image/png");
      expect(logoResponse.headers()["x-content-type-options"]).toBe("nosniff");
    });

    test("a member who does not own the deployment cannot brand it", async ({ browser }) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const stamp = Date.now();
      await signupUnder(page, brand.name, `brand-member-${stamp}@rakazo.test`, `Member ${stamp}`);
      await completeOnboarding(page);
      const settings = await openUserSettings(page);
      await expect(settings.getByTestId("settings-nav-general")).toBeVisible();
      await expect(settings.getByTestId("settings-nav-branding")).toHaveCount(0);
      await expect(rpc(page, "brand/update", { name: "Hijacked" })).rejects.toThrow(/403/);
      await context.close();
    });

    test("with a brand configured, no screen names the upstream product", async ({ browser }) => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const seen: string[] = [];
      const scan = async (label: string) => {
        seen.push(`${label}: ${await visibleText(page)}\n${await chromeText(page)}`);
      };

      await page.goto("/");
      await expect(page.getByRole("heading", { name: brand.name, exact: true })).toBeVisible();
      await expect(page.getByText(brand.tagline)).toBeVisible();
      await expect(page.getByTestId("brand-logo")).toBeVisible();
      await scan("welcome");
      await page.goto("/sign-in");
      await expect(page.getByRole("heading", { name: `Sign in to ${brand.name}` })).toBeVisible();
      await scan("sign-in");
      const stamp = Date.now();
      const userName = `Scan ${stamp}`;
      await page.goto("/sign-up");
      await scan("sign-up");
      await signupUnder(page, brand.name, `brand-scan-${stamp}@rakazo.test`, userName);
      await completeOnboarding(page);
      await scan("app");

      const settings = await openUserSettings(page);
      await scan("settings");
      await settings.getByTestId("settings-nav-models").click();
      await scan("models");

      for (const snapshot of seen) {
        expect(snapshot, snapshot.split("\n")[0]).not.toContain(UPSTREAM);
      }
      await context.close();
    });
  });

test("the product presents itself under the configured brand", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: BRAND_NAME, exact: true })).toBeVisible();
  expect(await page.title()).toBe(BRAND_NAME);
  const manifest = await linkedManifest(page);
  expect(manifest.name).toBe(BRAND_NAME);
  expect(manifest.short_name).toBe(process.env.PUBLIC_BRAND_SHORT_NAME?.trim() || BRAND_NAME);

  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: `Sign in to ${BRAND_NAME}` })).toBeVisible();
});

test("a white-labelled build shows no upstream name anywhere a user looks", async ({ page }) => {
  test.skip(!buildWhiteLabelled, "Runs when the web build was made with PUBLIC_BRAND_NAME set");
  const seen: string[] = [];
  const scan = async (label: string) => {
    seen.push(`${label}: ${await visibleText(page)}\n${await chromeText(page)}`);
  };

  await page.goto("/");
  await scan("welcome");
  await page.goto("/sign-in");
  await scan("sign-in");
  const stamp = Date.now();
  const userName = `Brand ${stamp}`;
  await signup(page, `brand-${stamp}@rakazo.test`, "password12", userName);
  await scan("sign-up");
  await completeOnboarding(page);
  await scan("app");

  const settings = await openUserSettings(page);
  await scan("settings");
  await settings.getByTestId("settings-nav-models").click();
  await scan("models");

  for (const snapshot of seen) {
    expect(snapshot, snapshot.split("\n")[0]).not.toContain(UPSTREAM);
  }
});

test("an upstream build names nothing but the upstream product", async ({ page }) => {
  test.skip(buildWhiteLabelled, "Runs for the default build only");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: UPSTREAM, exact: true })).toBeVisible();
  expect(await page.locator('link[rel="manifest"]').getAttribute("href")).toBe("/site.webmanifest");
  await expect(page.getByTestId("brand-logo")).toHaveCount(0);
});

test("only the deployment owner sees Branding in settings", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `brand-nav-${stamp}@rakazo.test`, "password12", `Nav ${stamp}`);
  await completeOnboarding(page);
  const me = await rpc<{ isDeploymentOwner: boolean }>(page, "me", null);
  const settings = await openUserSettings(page);
  await expect(settings.getByTestId("settings-nav-general")).toBeVisible();
  await expect(settings.getByTestId("settings-nav-branding")).toHaveCount(
    me.isDeploymentOwner ? 1 : 0,
  );
});
