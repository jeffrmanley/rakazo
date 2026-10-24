import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

it("public/zod-jitless.js turns zod's JIT off, so schemas never probe or build code", async () => {
  // A classic script in the browser; run it the same way, against this realm's globalThis.
  runInThisContext(readFileSync(new URL("../public/zod-jitless.js", import.meta.url), "utf8"));
  const { config, z } = await import("zod");
  // The global is the config zod reads; an upgrade that moves it fails here, not in a browser.
  expect(config()).toBe((globalThis as { __zod_globalConfig?: object }).__zod_globalConfig);
  expect(config().jitless).toBe(true);
  const blocked = vi.fn(() => {
    throw new EvalError("blocked by CSP");
  });
  vi.stubGlobal("Function", new Proxy(Function, { apply: blocked, construct: blocked }));
  const schema = z.object({ name: z.string(), count: z.number() });
  expect(schema.parse({ name: "a", count: 1 })).toEqual({ name: "a", count: 1 });
  expect(blocked).not.toHaveBeenCalled();
});
