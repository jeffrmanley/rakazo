import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";

/** Fork extensions with controls in the web app, and whether this deployment runs each. */
export type ExtModules = { emergencyStop: boolean; budgets: boolean; approvals: boolean };

export const EXT_MODULES_PATH = "/api/v1/ext/modules";

/**
 * `GET /api/v1/ext/modules`, for a signed-in session. A module that is off
 * has no routes (404); the web app reads this instead of probing them, so a
 * deployment without the module loads without failed requests.
 */
export function mountExtModulesRoute(
  app: Hono,
  deps: { modules: ExtModules; authenticate: (request: Request) => Promise<unknown> },
): void {
  app.get(EXT_MODULES_PATH, async (c) => {
    if (!(await deps.authenticate(c.req.raw))) {
      getLogger().warn("extension modules request without a session", {
        "http.path": EXT_MODULES_PATH,
      });
      return c.json({ error: "Unauthorized" }, 401);
    }
    c.header("cache-control", "no-store");
    return c.json(deps.modules);
  });
}
