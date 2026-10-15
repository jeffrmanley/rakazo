import { afterEach, expect, it, vi } from "vitest";
import { extModuleEnabled, resetExtModulesForTests } from "./ext-modules";

afterEach(() => {
  vi.unstubAllGlobals();
  resetExtModulesForTests();
});

it("asks the server once which modules run", async () => {
  const fetchMock = vi.fn(async () => Response.json({ emergencyStop: true, budgets: false }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(extModuleEnabled("emergencyStop")).resolves.toBe(true);
  await expect(extModuleEnabled("budgets")).resolves.toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/api/v1/ext/modules");
  expect(init.credentials).toBe("include");
});

it("leaves the decision to the module's own routes when the server cannot say, and asks again", async () => {
  const fetchMock = vi.fn(async () => new Response("", { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(extModuleEnabled("budgets")).resolves.toBe(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("offline");
    }),
  );
  await expect(extModuleEnabled("budgets")).resolves.toBe(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ emergencyStop: false, budgets: false })),
  );
  await expect(extModuleEnabled("budgets")).resolves.toBe(false);
});
