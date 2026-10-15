import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXT_MODULES_PATH, mountExtModulesRoute } from "./ext-modules.js";

let sink: ReturnType<typeof createTestSink>;

beforeEach(() => {
  sink = createTestSink();
  installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
});

afterEach(() => {
  installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
});

function app(modules: { emergencyStop: boolean; budgets: boolean; approvals: boolean }) {
  const hono = new Hono();
  mountExtModulesRoute(hono, {
    modules,
    authenticate: async (request) =>
      request.headers.get("cookie") === "session=ok" ? { userId: "u1", spaceId: "s1" } : null,
  });
  return hono;
}

describe("GET /api/v1/ext/modules", () => {
  it("tells a signed-in session which optional modules run, even when all are off", async () => {
    for (const modules of [
      { emergencyStop: false, budgets: false, approvals: false },
      { emergencyStop: true, budgets: false, approvals: false },
      { emergencyStop: false, budgets: true, approvals: false },
      { emergencyStop: false, budgets: false, approvals: true },
    ]) {
      const res = await app(modules).request(EXT_MODULES_PATH, {
        headers: { cookie: "session=ok" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual(modules);
    }
  });

  it("refuses and logs a request without a session", async () => {
    const res = await app({ emergencyStop: true, budgets: true, approvals: true }).request(
      EXT_MODULES_PATH,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(sink.events).toEqual([
      expect.objectContaining({ level: "warn", "http.path": EXT_MODULES_PATH }),
    ]);
  });
});
