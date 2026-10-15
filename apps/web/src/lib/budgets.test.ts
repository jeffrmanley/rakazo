import { afterEach, expect, it, vi } from "vitest";
import {
  fetchBotBudget,
  fetchSpaceBudget,
  parseLimitInput,
  parseUsdInput,
  saveBotBudget,
} from "./budgets";
import { resetExtModulesForTests } from "./ext-modules";

afterEach(() => {
  vi.unstubAllGlobals();
  resetExtModulesForTests();
});

it("does not ask for budgets when the module is off, so nothing is shown", async () => {
  const fetchMock = vi.fn(async (url: string) =>
    url === "/api/v1/ext/modules"
      ? Response.json({ emergencyStop: false, budgets: false })
      : Response.json({}),
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(fetchSpaceBudget()).resolves.toBeNull();
  await expect(fetchBotBudget("bot_1")).resolves.toBeNull();
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/v1/ext/modules"]);
});

it("treats a 404 as budgets being off, so nothing is shown", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("Not found", { status: 404 })),
  );
  await expect(fetchSpaceBudget()).resolves.toBeNull();
  await expect(fetchBotBudget("bot_1")).resolves.toBeNull();
});

it("sends the patch as JSON and surfaces the server's reason on refusal", async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({ error: "Only a space owner can change premium" }, { status: 403 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(saveBotBudget("bot/1", { premium: true })).rejects.toThrow(
    "Only a space owner can change premium",
  );
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/v1/budgets/bots/bot%2F1");
  expect(init).toMatchObject({ method: "PUT", body: '{"premium":true}', credentials: "include" });
});

it("falls back to a generic message when the error body is not JSON", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("<html>Gateway error</html>", { status: 502 })),
  );
  await expect(saveBotBudget("bot_1", { profile: "worker" })).rejects.toThrow("Could not save");
});

it("parses typed amounts and limits", () => {
  expect(parseUsdInput(" 12.5 ")).toBe(12.5);
  expect(parseUsdInput("")).toBeNull();
  expect(parseUsdInput("abc")).toBeNull();
  expect(parseLimitInput("")).toBeNull();
  expect(parseLimitInput("3")).toBe(3);
  expect(parseLimitInput("1.5")).toBeUndefined();
  expect(parseLimitInput("-1")).toBeUndefined();
});
