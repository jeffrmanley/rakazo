import { describe, expect, it, vi } from "vitest";
import { DesktopUpdateController, type ElectronAutoUpdater } from "./auto-update.js";
import { AUTO_UPDATE_ENABLED } from "./fork-config.js";

/** The same environment main.ts builds for an installed (packaged) withJZ Crew app. */
const installedBuild = { packaged: true, version: "0.2.0", disabled: !AUTO_UPDATE_ENABLED };

describe("withJZ Crew updater", () => {
  it("never loads an updater or touches a feed, even when the renderer asks", async () => {
    const checkForUpdates = vi.fn(async () => undefined);
    const loadUpdater = vi.fn(
      async () => ({ checkForUpdates, on: vi.fn() }) as unknown as ElectronAutoUpdater,
    );
    const controller = new DesktopUpdateController(installedBuild, loadUpdater, {
      now: () => 10_000_000,
      iso: () => "2026-11-16T00:00:00.000Z",
    });

    // Launch check, hourly check, then a connected page pressing every button.
    await controller.check(false);
    await controller.check(false);
    await controller.check(true);
    await controller.download();
    await controller.install();

    expect(loadUpdater).not.toHaveBeenCalled();
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(controller.state()).toMatchObject({
      phase: "unsupported",
      availableVersion: null,
      message: "Automatic updates are turned off for this install.",
    });
  });
});
