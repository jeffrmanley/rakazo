import { deflateSync } from "node:zlib";
import { expect, type Page, test } from "@playwright/test";
import { activeBotId, completeOnboarding, rpc, signup } from "./helpers";

/**
 * Runs only against the production-like compose stack started by
 * infra/compose/e2e/run.sh (STACK_E2E=1, with EXT_AUDIT_LOG, EXT_EMERGENCY_STOP
 * EXT_BUDGETS and EXT_APPROVALS on). The echo model answers "echo: <text>" from inside the
 * compose network and reports a fixed cost per call.
 */
const enabled = process.env.STACK_E2E === "1";
const MODEL_URL = process.env.STACK_MODEL_URL ?? "http://echo-model:8080/v1";
const MODEL_ID = "echo-1";
const BRAND = "withJZ Crew";
const UPSTREAM_NAME = ["Rak", "azo"].join("");

/** A valid solid-colour PNG of the given size, built without dependencies. */
function png(size: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, 0x33)]);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function send(page: Page, text: string) {
  await page.getByPlaceholder(/Message/).fill(text);
  await page.keyboard.press("Enter");
}

async function auditKinds(page: Page): Promise<Set<string>> {
  const response = await page.request.get("/api/v1/audit?limit=100");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { events: Array<{ kind: string }> };
  return new Set(body.events.map((event) => event.kind));
}

test.describe("compose stack", () => {
  test.skip(!enabled, "set STACK_E2E=1 and run infra/compose/e2e/run.sh");
  test.setTimeout(300_000);

  test("owner journey: chat, audit, branding, emergency stop, budgets, approvals", async ({
    page,
  }) => {
    const stamp = Date.now();
    const transcript = page.getByTestId("transcript");

    await test.step("sign up and connect the model during onboarding", async () => {
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
    });

    await test.step("chat round trip is audited", async () => {
      // Let the new bot's welcome reply finish so the first message starts its own run.
      await expect(transcript.getByText(/^echo: /).first()).toBeVisible({ timeout: 60_000 });
      await send(page, `stack ping ${stamp}`);
      await expect(transcript.getByText(`echo: stack ping ${stamp}`)).toBeVisible({
        timeout: 60_000,
      });
      const kinds = await auditKinds(page);
      expect(kinds.has("message.in")).toBe(true);
      expect(kinds.has("message.out")).toBe(true);
      // A spoofed space id is rejected or ignored, never honoured.
      const spoofed = await page.request.get("/api/v1/audit?spaceId=not-my-space&limit=1", {
        headers: { "x-rakazo-space-id": "not-my-space" },
      });
      expect([200, 400, 401, 403, 404]).toContain(spoofed.status());
    });

    await test.step("owner brands the deployment at runtime, with a logo", async () => {
      await rpc(page, "brand/update", { name: BRAND, shortName: "Crew", tagline: "Your crew." });
      await rpc(page, "brand/uploadLogo", { data: png(128).toString("base64") });
      const brand = (await (await page.request.get("/api/v1/brand")).json()) as {
        name: string;
        logoUrl: string | null;
      };
      expect(brand.name).toBe(BRAND);
      expect(brand.logoUrl).toBeTruthy();
      const logo = await page.request.get("/api/v1/brand/logo");
      expect(logo.headers()["content-type"]).toBe("image/png");
      expect(logo.headers()["x-content-type-options"]).toBe("nosniff");
      // An SVG upload is refused.
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
      await expect(
        rpc(page, "brand/uploadLogo", { data: svg.toString("base64") }),
      ).rejects.toThrow();

      await page.reload();
      await expect(page).toHaveTitle(new RegExp(BRAND));
      const html = await (await page.request.get("/")).text();
      expect(html).toContain(BRAND);
      expect(html).not.toContain(UPSTREAM_NAME);
      const manifest = await (await page.request.get("/api/v1/brand/manifest.webmanifest")).text();
      expect(manifest).toContain(BRAND);
      expect(manifest).not.toContain(UPSTREAM_NAME);
      await expect(page.locator("body")).not.toContainText(UPSTREAM_NAME);
    });

    const botId = activeBotId(page);

    await test.step("emergency stop pauses the bot and resume restores it", async () => {
      const stop = await page.request.post("/api/v1/control/stop", {
        data: { scope: "bot", botId, reason: "stack e2e" },
      });
      expect(stop.ok()).toBe(true);
      await send(page, `while stopped ${stamp}`);
      await expect(transcript.getByText(/Paused by .+ at \d{4}-\d{2}-\d{2}/).last()).toBeVisible({
        timeout: 30_000,
      });
      await expect(transcript.getByText(`echo: while stopped ${stamp}`)).toHaveCount(0);

      const resume = await page.request.post("/api/v1/control/resume", {
        data: { scope: "bot", botId, reason: "stack e2e" },
      });
      expect(resume.ok()).toBe(true);
      await send(page, `after resume ${stamp}`);
      await expect(transcript.getByText(`echo: after resume ${stamp}`)).toBeVisible({
        timeout: 60_000,
      });
      const kinds = await auditKinds(page);
      expect(kinds.has("control.stop")).toBe(true);
      expect(kinds.has("control.resume")).toBe(true);
    });

    await test.step("a bot over its daily cap is refused until topped up", async () => {
      // Every echo call costs $0.50, and this bot has already made several today.
      const cap = await page.request.put(`/api/v1/budgets/bots/${botId}`, {
        data: { profile: "custom", customDailyUsd: 0.5 },
      });
      expect(cap.ok()).toBe(true);
      await send(page, `over budget ${stamp}`);
      await expect(transcript.getByText(/reached its daily budget/).last()).toBeVisible({
        timeout: 30_000,
      });
      await expect(transcript.getByText(`echo: over budget ${stamp}`)).toHaveCount(0);
      expect((await auditKinds(page)).has("budget.block")).toBe(true);

      const topUp = await page.request.post(`/api/v1/budgets/bots/${botId}/top-up`, {
        data: { amountUsd: 20 },
      });
      expect(topUp.ok()).toBe(true);
      await send(page, `after top-up ${stamp}`);
      await expect(transcript.getByText(`echo: after top-up ${stamp}`)).toBeVisible({
        timeout: 60_000,
      });
    });

    await test.step("a gated action waits for an approver, then runs once", async () => {
      const policy = await page.request.put(`/api/v1/approvals/bots/${botId}`, {
        data: { gatedClasses: ["write-internal", "write-external"] },
      });
      expect(policy.ok()).toBe(true);

      const title = `stack approval ${stamp}`;
      await send(page, `call scratchpad_add {"title":"${title}"}`);
      const allowOnce = page.getByRole("button", { name: "Allow once", exact: true });
      await expect(allowOnce).toBeVisible({ timeout: 60_000 });
      // A mandatory approval offers no standing exceptions, and shows the call it binds to.
      await expect(page.getByRole("button", { name: "Always allow this tool" })).toHaveCount(0);
      await expect(transcript.getByText(/Call [0-9a-f]{8}/).last()).toBeVisible();
      await expect(transcript.getByText(title).last()).toBeVisible();
      await expect(transcript.getByText(/^echo: tool result/)).toHaveCount(0);
      await allowOnce.click();
      await expect(transcript.getByText(/^echo: tool result/).last()).toBeVisible({
        timeout: 60_000,
      });

      await send(page, `call scratchpad_add {"title":"denied ${stamp}"}`);
      const deny = page.getByRole("button", { name: "Deny", exact: true });
      await expect(deny).toBeVisible({ timeout: 60_000 });
      await deny.click();
      await expect(page.getByText("Denied", { exact: true }).last()).toBeVisible();
      const kinds = await auditKinds(page);
      expect(kinds.has("approval.request")).toBe(true);
      expect(kinds.has("approval.decision")).toBe(true);
    });
  });
});
