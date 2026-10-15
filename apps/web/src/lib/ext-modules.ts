/**
 * Fork extensions with controls in the web app. A module that is off has no
 * routes (404), so the app asks the server which ones run (once per page load)
 * instead of probing them, and a deployment without them loads without failed
 * requests.
 */
export type ExtModule = "emergencyStop" | "budgets" | "approvals";

const MODULES_PATH = "/api/v1/ext/modules";

let modulesRequest: Promise<Partial<Record<ExtModule, boolean>> | null> | undefined;

async function loadModules(): Promise<Partial<Record<ExtModule, boolean>> | null> {
  try {
    const response = await fetch(MODULES_PATH, {
      credentials: "include",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return (await response.json()) as Partial<Record<ExtModule, boolean>>;
  } catch {
    // Offline or restarting: ask again next time.
  }
  modulesRequest = undefined;
  return null;
}

/** False when the server says the module is off; true when it runs or the server cannot say. */
export async function extModuleEnabled(name: ExtModule): Promise<boolean> {
  modulesRequest ??= loadModules();
  return (await modulesRequest)?.[name] !== false;
}

export function resetExtModulesForTests(): void {
  modulesRequest = undefined;
}
