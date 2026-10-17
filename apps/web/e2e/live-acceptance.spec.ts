import { randomBytes } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { completeOnboarding, rpc, signup } from "./helpers";

/**
 * Acceptance checks against a running deployment, after `rakazo-deploy deploy`:
 *   LIVE_E2E=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:5173 pnpm --filter @rakazo/web exec \
 *     playwright test e2e/live-acceptance.spec.ts
 *
 * Uses a throwaway user with a space of their own, exercises the governance modules on that
 * space only, and deletes the account at the end. It never signs in as the owner and never
 * changes deployment-wide settings: every owner-only call it makes must be refused. Chat runs
 * only when the deployment provides a model to new users (a few short messages).
 *
 * Sign-ups are allowlist-only on a real deployment, so pass an account made with
 * `test-account create` (docs/test-accounts.md) as LIVE_TEST_EMAIL and LIVE_TEST_PASSWORD.
 * Without them the test signs up a new address, which only works where sign-ups are open.
 */
const enabled = process.env.LIVE_E2E === "1";
const BRAND = process.env.LIVE_BRAND_NAME ?? "withJZ Crew";
const UPSTREAM_NAME = ["Rak", "azo"].join("");

async function auditEvents(page: Page) {
  const response = await page.request.get("/api/v1/audit?limit=100");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { events: Array<Record<string, unknown> & { kind: string }> })
    .events;
}

async function send(page: Page, text: string) {
  await page.getByPlaceholder(/Message/).fill(text);
  await page.keyboard.press("Enter");
}

test.describe("live deployment", () => {
  test.skip(!enabled, "set LIVE_E2E=1 and PLAYWRIGHT_BASE_URL to a running deployment");
  // Traces and videos would record the test account's password.
  test.use({ trace: "off", video: "off" });
  test.setTimeout(300_000);

  test("public pages carry the brand and never the upstream name", async ({ page, request }) => {
    const html = await (await request.get("/")).text();
    expect(html).not.toContain(UPSTREAM_NAME);
    const brand = (await (await request.get("/api/v1/brand")).json()) as { name: string };
    expect(brand.name).toBe(BRAND);
    const manifest = await (await request.get("/api/v1/brand/manifest.webmanifest")).text();
    expect(manifest).toContain(BRAND);
    expect(manifest).not.toContain(UPSTREAM_NAME);
    for (const path of ["/sign-in", "/sign-up"]) {
      await page.goto(path);
      await expect(page).toHaveTitle(new RegExp(BRAND));
      await expect(page.locator("body")).toContainText(BRAND);
      await expect(page.locator("body")).not.toContainText(UPSTREAM_NAME);
    }
  });

  test("anonymous and unsigned requests are refused", async ({ request }) => {
    for (const path of [
      "/api/v1/audit?limit=1",
      "/api/v1/control/state",
      "/api/v1/budgets/bots/any",
      "/api/v1/approvals/bots/any",
    ]) {
      expect((await request.get(path)).status(), path).toBe(401);
    }
    const stop = await request.post("/api/v1/control/stop", {
      data: { scope: "global", reason: "live check" },
    });
    expect(stop.status()).toBe(401);
    const brand = await request.post("/rpc/brand/update", { data: { json: { name: "x" } } });
    expect([401, 403]).toContain(brand.status());
    // The chat webhooks are reachable from the internet: unsigned calls must bounce.
    const challenge = { type: "url_verification", challenge: "live-check" };
    for (const provider of ["slack", "teams"]) {
      const response = await request.post(`/api/v1/messaging/webhook/${provider}`, {
        data: challenge,
      });
      expect([401, 403], provider).toContain(response.status());
      expect(await response.text()).not.toContain("live-check");
    }
  });

  test("a new user's space: default deny, isolation, stop and resume, chat", async ({
    page,
  }, testInfo) => {
    const stamp = Date.now();
    const provided = process.env.LIVE_TEST_EMAIL && process.env.LIVE_TEST_PASSWORD;
    const email = process.env.LIVE_TEST_EMAIL ?? `live-check-${stamp}@example.test`;
    const password = process.env.LIVE_TEST_PASSWORD ?? randomBytes(18).toString("base64url");
    let signedIn = false;

    try {
      await test.step(
        provided ? "sign in as the test account" : "sign up a throwaway user",
        async () => {
          if (provided) {
            await page.goto("/sign-in");
            await page.getByPlaceholder("Your email address").fill(email);
            await page.getByPlaceholder("Password").fill(password);
            await page.getByRole("button", { name: "Continue with email" }).click();
          } else {
            await signup(page, email, password, `Live check ${stamp}`);
          }
          const refused = page.getByText("Email is not allowed to register");
          await page
            .waitForURL(/\/(onboarding|app)/, { timeout: 30_000 })
            .catch(async (error: unknown) => {
              if (!provided && (await refused.isVisible())) {
                test.skip(true, "sign-ups are closed; pass a test account (docs/test-accounts.md)");
              }
              throw error;
            });
          signedIn = true;
        },
      );

      const needsModel = await page
        .getByRole("heading", { name: "Connect a model" })
        .waitFor({ timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      testInfo.annotations.push({
        type: "model",
        description: needsModel
          ? "deployment gives new users no model: chat steps skipped"
          : "deployment model in use",
      });
      if (!needsModel) await completeOnboarding(page);
      await expect(page.locator("body")).not.toContainText(UPSTREAM_NAME);

      await test.step("owner-only actions are refused", async () => {
        await expect(rpc(page, "brand/update", { name: "hijacked" })).rejects.toThrow();
        const brand = (await (await page.request.get("/api/v1/brand")).json()) as {
          name: string;
        };
        expect(brand.name).toBe(BRAND);
        const global = await page.request.post("/api/v1/control/stop", {
          data: { scope: "global", reason: "live check" },
        });
        expect(global.status()).toBe(403);
        const state = (await (await page.request.get("/api/v1/control/state")).json()) as {
          canControl: boolean;
          canControlGlobal: boolean;
          stops: unknown[];
        };
        expect(state.canControlGlobal).toBe(false);
        expect(state.canControl).toBe(true);
        expect(state.stops).toHaveLength(0);
      });

      await test.step("stop and resume this space, both audited", async () => {
        const stop = await page.request.post("/api/v1/control/stop", {
          data: { scope: "space", reason: "live check" },
        });
        expect(stop.ok()).toBe(true);
        const stopped = (await (await page.request.get("/api/v1/control/state")).json()) as {
          stops: Array<{ scope: string }>;
        };
        expect(stopped.stops.map((s) => s.scope)).toEqual(["space"]);
        const resume = await page.request.post("/api/v1/control/resume", {
          data: { scope: "space", reason: "live check" },
        });
        expect(resume.ok()).toBe(true);
        const kinds = new Set((await auditEvents(page)).map((event) => event.kind));
        expect(kinds.has("control.stop")).toBe(true);
        expect(kinds.has("control.resume")).toBe(true);
      });

      await test.step("the audit log shows only this user's space", async () => {
        const events = await auditEvents(page);
        const own = JSON.stringify(events);
        // Nothing from any other space leaks into this user's view; a spoofed space is ignored.
        const spoofed = await page.request.get("/api/v1/audit?spaceId=other&limit=100", {
          headers: { "x-rakazo-space-id": "other" },
        });
        expect([200, 400, 403, 404]).toContain(spoofed.status());
        if (spoofed.ok()) {
          const body = (await spoofed.json()) as { events: unknown[] };
          expect(JSON.stringify(body.events)).toBe(own);
        }
        for (const event of events) {
          expect(JSON.stringify(event)).not.toMatch(/xox[abposr]-|sk-[A-Za-z0-9]{8}/);
        }
      });

      if (needsModel) return;

      await test.step("chat round trip with the deployment's model is audited", async () => {
        const replies = async () =>
          (await auditEvents(page)).filter((event) => event.kind === "message.out").length;
        // Let the new bot's welcome reply finish so the message starts its own run.
        await expect.poll(replies, { timeout: 120_000 }).toBeGreaterThan(0);
        const before = await replies();
        const question = `Reply with just the word ok. (${stamp})`;
        await send(page, question);
        await expect(page.getByTestId("transcript").getByText(question)).toBeVisible();
        await expect.poll(replies, { timeout: 120_000 }).toBeGreaterThan(before);
        const kinds = new Set((await auditEvents(page)).map((event) => event.kind));
        expect(kinds.has("message.in")).toBe(true);
      });
    } finally {
      if (signedIn) {
        // Delete the throwaway account; the append-only audit trail keeps its events.
        const deleted = await page.request.post("/api/auth/delete-user", { data: { password } });
        testInfo.annotations.push({
          type: "cleanup",
          description: `delete-user ${deleted.status()} for ${email}`,
        });
        expect(deleted.ok()).toBe(true);
      }
    }
  });
});
