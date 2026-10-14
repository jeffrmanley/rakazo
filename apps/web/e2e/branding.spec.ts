import { expect, type Page, test } from "@playwright/test";
import { BRAND_NAME, completeOnboarding, signup } from "./helpers";

const UPSTREAM = "Rakazo";
const whiteLabelled = BRAND_NAME !== UPSTREAM;

/** Visible text of the page, minus the Apache-2.0 credit that names upstream on purpose. */
async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = document.body.cloneNode(true) as HTMLElement;
    for (const credit of root.querySelectorAll('[data-testid="brand-credit"]')) credit.remove();
    return root.innerText;
  });
}

/** Attributes browsers surface outside the page body: tab title and the PWA manifest. */
async function chromeText(page: Page): Promise<string> {
  const title = await page.title();
  const manifest = await page.request.get("/site.webmanifest");
  expect(manifest.ok()).toBe(true);
  const body = (await manifest.json()) as { name: string; short_name: string };
  return [title, body.name, body.short_name].join("\n");
}

test("the product presents itself under the configured brand", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: BRAND_NAME, exact: true })).toBeVisible();
  expect(await page.title()).toBe(BRAND_NAME);
  const manifest = (await (await page.request.get("/site.webmanifest")).json()) as {
    name: string;
    short_name: string;
  };
  expect(manifest.name).toBe(BRAND_NAME);
  expect(manifest.short_name).toBe(process.env.PUBLIC_BRAND_SHORT_NAME?.trim() || BRAND_NAME);

  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: `Sign in to ${BRAND_NAME}` })).toBeVisible();
});

test("a white-labelled build shows no upstream name anywhere a user looks", async ({ page }) => {
  test.skip(!whiteLabelled, "Runs when the web build was made with PUBLIC_BRAND_NAME set");
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

  await page.getByRole("button", { name: new RegExp(userName) }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByTestId("user-settings")).toBeVisible();
  await scan("settings");
  // The credit is the one place upstream is named, and only when white-labelled.
  const credit = page.getByTestId("brand-credit");
  await expect(credit).toContainText(`Built on ${UPSTREAM}`);
  await expect(credit.getByRole("link")).toHaveAttribute("href", /github\.com\/elie222\/rakazo/);
  await page
    .getByTestId("user-settings")
    .getByRole("button", { name: "Models", exact: true })
    .click();
  await scan("models");

  for (const snapshot of seen) {
    expect(snapshot, snapshot.split("\n")[0]).not.toContain(UPSTREAM);
  }
});

test("an upstream build names nothing but the upstream product", async ({ page }) => {
  test.skip(whiteLabelled, "Runs for the default build only");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: UPSTREAM, exact: true })).toBeVisible();
  const stamp = Date.now();
  const userName = `Upstream ${stamp}`;
  await signup(page, `upstream-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);
  await page.getByRole("button", { name: new RegExp(userName) }).click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByTestId("user-settings")).toBeVisible();
  await expect(page.getByTestId("brand-credit")).toHaveCount(0);
});
