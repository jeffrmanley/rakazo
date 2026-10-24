import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { totpCode, wrongTotpCode } from "../../../packages/testkit/src/totp";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

const PASSWORD = "two-factor-password-12";
/**
 * The owner journey turns on require2faForAll, which would send every other spec's account to
 * enrolment, so it needs a fresh database where its first sign-up owns the deployment and
 * nothing runs beside it: TWO_FACTOR_E2E_OWNER=1 pnpm test:e2e --spec=e2e/two-factor.spec.ts
 */
const ownerRun = process.env.TWO_FACTOR_E2E_OWNER === "1";
// The owner journey goes first so its account is the first sign-up.
test.describe.configure({ mode: "serial" });

const uriFor = (key: string) => `otpauth://totp/e2e?secret=${key.replace(/\s+/g, "")}`;

/** Runs the setup steps already on screen in `scope`; returns the key and the backup codes. */
async function enrol(
  page: Page,
  scope: ReturnType<Page["locator"]>,
  testInfo?: Parameters<typeof captureScreenshot>[1],
) {
  await scope.getByLabel("Current password").fill(PASSWORD);
  await scope.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    scope.getByRole("img", { name: "QR code for your authenticator app" }),
  ).toBeVisible();
  await scope.getByText("Can’t scan it?").click();
  const key = (await scope.getByTestId("two-factor-manual-key").textContent()) ?? "";
  expect(key).toMatch(/^[A-Z2-7 ]{20,}$/);
  if (testInfo) await captureScreenshot(page, testInfo, "two-factor-scan");
  await scope.getByLabel("Code", { exact: true }).fill(wrongTotpCode(uriFor(key)));
  await scope.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(scope.getByRole("alert")).toContainText("That code didn’t work");
  await scope.getByLabel("Code", { exact: true }).fill(totpCode(uriFor(key)));
  await scope.getByRole("button", { name: "Confirm", exact: true }).click();
  const codes = scope.getByTestId("two-factor-backup-codes").getByRole("listitem");
  await expect(codes).toHaveCount(10);
  if (testInfo) await captureScreenshot(page, testInfo, "two-factor-backup-codes");
  const backupCodes = await codes.allTextContents();
  await scope.getByRole("button", { name: "I saved them" }).click();
  return { key, backupCodes };
}

async function signInWithPassword(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByPlaceholder("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Continue with email" }).click();
}

async function dropSession(context: BrowserContext) {
  const keep = (await context.cookies()).filter((cookie) => !cookie.name.includes("session_token"));
  await context.clearCookies();
  await context.addCookies(keep);
}

test("the owner enrols from the banner and can require two-factor for everyone", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(!ownerRun, "needs a fresh database it owns: set TWO_FACTOR_E2E_OWNER=1");
  await signup(page, `two-factor-owner-${Date.now()}@rakazo.test`, PASSWORD, "Owner");
  await completeOnboarding(page);
  const banner = page.getByTestId("two-factor-banner");
  await expect(banner).toContainText("Turn on two-factor sign-in to protect this deployment.");
  await captureScreenshot(page, testInfo, "two-factor-owner-banner");
  // The banner does not stop the owner from working.
  await openUserSettings(page, "general");
  await page.keyboard.press("Escape");

  await banner.getByRole("button", { name: "Turn on", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Two-factor authentication" });
  await enrol(page, dialog);
  await expect(banner).toHaveCount(0);

  const settings = await openUserSettings(page, "security");
  const toggle = settings.getByTestId("require-two-factor-toggle");
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await captureScreenshot(page, testInfo, "two-factor-require-for-all");

  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  try {
    await signup(member, `two-factor-member-${Date.now()}@rakazo.test`, PASSWORD, "Member");
    const required = member.getByTestId("two-factor-required");
    await expect(
      required.getByRole("heading", { name: "Set up two-factor sign-in" }),
    ).toBeVisible();
    await captureScreenshot(member, testInfo, "two-factor-required");
    await enrol(member, required);
    await completeOnboarding(member);
    await expect(member.getByTestId("two-factor-required")).toHaveCount(0);
  } finally {
    await memberContext.close();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
  }
});

test("enrols from Settings, then signs in with a code, a trusted device and a backup code", async ({
  page,
  context,
}, testInfo) => {
  const email = `two-factor-${Date.now()}@rakazo.test`;
  await signup(page, email, PASSWORD, "Two Factor");
  await completeOnboarding(page);

  const settings = await openUserSettings(page, "security");
  const section = settings.getByTestId("two-factor-settings");
  await expect(section.getByTestId("two-factor-status")).toHaveText("Off.");
  await captureScreenshot(page, testInfo, "two-factor-settings-off");
  await section.getByRole("button", { name: "Turn on", exact: true }).click();
  const { key, backupCodes } = await enrol(page, section, testInfo);
  await expect(section.getByTestId("two-factor-status")).toContainText("On.");
  await expect(page.getByTestId("two-factor-banner")).toHaveCount(0);

  // Password alone no longer signs in.
  await context.clearCookies();
  await signInWithPassword(page, email);
  await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  await captureScreenshot(page, testInfo, "two-factor-sign-in-code");
  await page.getByLabel("Authenticator code").fill(wrongTotpCode(uriFor(key)));
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("That code didn’t work");
  await page.getByLabel("Authenticator code").fill(totpCode(uriFor(key)));
  await page.getByRole("checkbox", { name: "Trust this device for 30 days" }).check();
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await page.waitForURL(/\/app/);
  await expect(page.getByTestId("user-menu-trigger")).toBeVisible();

  // The trusted device skips the code.
  await dropSession(context);
  await signInWithPassword(page, email);
  await page.waitForURL(/\/app/);
  await expect(page.getByTestId("user-menu-trigger")).toBeVisible();

  // A new device can use a backup code instead.
  await context.clearCookies();
  await signInWithPassword(page, email);
  await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  await page.getByRole("button", { name: "Use a backup code" }).click();
  await page.getByLabel("Backup code").fill(backupCodes[0]!);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await page.waitForURL(/\/app/);

  // Turning it off needs the password and a current code.
  const again = await openUserSettings(page, "security");
  const panel = again.getByTestId("two-factor-settings");
  await panel.getByRole("button", { name: "Turn off", exact: true }).click();
  await panel.getByLabel("Current password").fill(PASSWORD);
  await panel.getByLabel("Code or backup code").fill(wrongTotpCode(uriFor(key)));
  await panel.getByRole("button", { name: "Turn off two-factor sign-in" }).click();
  await expect(panel.getByRole("alert")).toContainText("That code didn’t work");
  await panel.getByLabel("Code or backup code").fill(totpCode(uriFor(key)));
  await panel.getByRole("button", { name: "Turn off two-factor sign-in" }).click();
  await expect(panel.getByTestId("two-factor-status")).toHaveText("Off.");
});
