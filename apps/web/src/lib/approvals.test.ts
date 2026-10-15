import { afterEach, expect, it, vi } from "vitest";
import { fetchBotApprovals, saveBotApprovals } from "./approvals";
import { resetExtModulesForTests } from "./ext-modules";

afterEach(() => {
  vi.unstubAllGlobals();
  resetExtModulesForTests();
});

it("does not ask for approvals when the module is off, so bot settings stay unchanged", async () => {
  const fetchMock = vi.fn(async (url: string) =>
    url === "/api/v1/ext/modules"
      ? Response.json({ emergencyStop: true, budgets: true, approvals: false })
      : Response.json({}),
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(fetchBotApprovals("bot_1")).resolves.toBeNull();
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/v1/ext/modules"]);
});

it("shows nothing for a 404 (not a space owner, or the module is off)", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("Not found", { status: 404 })),
  );
  await expect(fetchBotApprovals("bot_1")).resolves.toBeNull();
});

it("sends the patch as JSON and surfaces the server's reason on refusal", async () => {
  const fetchMock = vi.fn(async () =>
    Response.json({ error: "Approvers must be members of this space" }, { status: 400 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(saveBotApprovals("bot/1", { approverUserIds: ["u9"] })).rejects.toThrow(
    "Approvers must be members of this space",
  );
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/v1/approvals/bots/bot%2F1");
  expect(init).toMatchObject({
    method: "PUT",
    body: '{"approverUserIds":["u9"]}',
    credentials: "include",
  });
});
