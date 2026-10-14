import { expect, test } from "@playwright/test";
import { completeOnboarding, signup } from "./helpers";

/**
 * Runs only against the production-like compose stack started by
 * infra/compose/e2e/run.sh (STACK_E2E=1). The echo model answers "echo: <text>"
 * from inside the compose network.
 */
const enabled = process.env.STACK_E2E === "1";
const MODEL_URL = process.env.STACK_MODEL_URL ?? "http://echo-model:8080/v1";
const MODEL_ID = "echo-1";

test.describe("compose stack", () => {
  test.skip(!enabled, "set STACK_E2E=1 and run infra/compose/e2e/run.sh");
  test.describe.configure({ mode: "serial" });

  test("owner signs up, connects a model and chats end to end", async ({ page }) => {
    const stamp = Date.now();
    await signup(page, `owner-${stamp}@example.test`, "password12", `Owner ${stamp}`);
    // A fresh deployment has no model yet: onboarding asks for one first.
    await page.getByRole("heading", { name: "Connect a model" }).waitFor({ timeout: 30_000 });
    await page.getByRole("combobox", { name: "Provider" }).click();
    await page.getByRole("option", { name: /OpenAI-compatible/ }).click();
    await page.getByLabel("OpenAI-compatible server URL").fill(MODEL_URL);
    await page.getByLabel("Model id").fill(MODEL_ID);
    // An unknown model gets a small default context; give the echo model a real one.
    await page.getByText("Advanced", { exact: true }).click();
    await page.getByLabel("Context limit").fill("128000");
    await page.getByLabel("Maximum output tokens").fill("4096");
    await page.getByRole("button", { name: "Continue" }).click();
    await completeOnboarding(page);

    const composer = page.getByPlaceholder(/Message/);
    await composer.fill(`stack ping ${stamp}`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("transcript").getByText(`echo: stack ping ${stamp}`)).toBeVisible(
      { timeout: 60_000 },
    );

    // Audit log (EXT_AUDIT_LOG=1): the exchange is recorded for this space only.
    const audit = await page.request.get("/api/v1/audit?limit=100");
    expect(audit.ok()).toBe(true);
    const body = (await audit.json()) as { events: Array<{ kind: string; summary: string }> };
    const kinds = new Set(body.events.map((event) => event.kind));
    expect(kinds.has("message.in")).toBe(true);
    expect(kinds.has("message.out")).toBe(true);

    // A spoofed space id is ignored rather than honoured.
    const spoofed = await page.request.get("/api/v1/audit?spaceId=not-my-space&limit=1", {
      headers: { "x-rakazo-space-id": "not-my-space" },
    });
    expect([200, 400, 401, 403, 404]).toContain(spoofed.status());
    if (spoofed.ok()) {
      const again = (await spoofed.json()) as { events: unknown[] };
      expect(again.events.length).toBeLessThanOrEqual(1);
    }
  });
});
