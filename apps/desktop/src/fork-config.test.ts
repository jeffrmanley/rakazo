import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_USER_MODEL_ID,
  AUTO_UPDATE_ENABLED,
  DEFAULT_SERVER_URL,
  localStackEnabled,
  PRODUCT_NAME,
} from "./fork-config.js";
import { normalizeServerUrl } from "./setup-config.js";

const root = path.resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  productName: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  build: {
    appId: string;
    publish?: unknown;
    extraResources?: Array<{ from: string; to: string }>;
    win: { icon: string; target: Array<{ target: string; arch: string[] }> };
    nsis: Record<string, unknown>;
    electronFuses?: Record<string, boolean>;
  };
};

describe("withJZ Crew build settings", () => {
  it("names the product and matches the Windows app id to electron-builder", () => {
    expect(PRODUCT_NAME).toBe("withJZ Crew");
    expect(packageJson.productName).toBe(PRODUCT_NAME);
    expect(APP_USER_MODEL_ID).toBe("com.withjz.crew.desktop");
    expect(packageJson.build.appId).toBe(APP_USER_MODEL_ID);
  });

  it("prefills the deployment's HTTPS origin, which setup accepts unchanged", () => {
    expect(DEFAULT_SERVER_URL).toBe("https://eu-2.tail290516.ts.net");
    expect(normalizeServerUrl(DEFAULT_SERVER_URL)).toBe(DEFAULT_SERVER_URL);
  });

  it("builds an x64 NSIS installer with withJZ Crew installer and shortcut names", () => {
    expect(packageJson.build.win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
    expect(packageJson.build.nsis).toMatchObject({
      shortcutName: "withJZ Crew",
      uninstallDisplayName: "withJZ Crew",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder macro syntax
      artifactName: "withJZ-Crew-Setup-${version}.${ext}",
      perMachine: false,
    });
  });

  it("uses the withJZ Crew icons", () => {
    const ico = readFileSync(path.join(root, packageJson.build.win.icon));
    // ICO header: reserved 0, type 1, then the image count.
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(6);
    // The 256 px entry is stored with a width byte of 0; electron-builder requires it.
    const widths = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico.readUInt8(6 + i * 16));
    expect(widths).toContain(0);
    expect(readFileSync(path.join(root, "assets/icon.png"))).toEqual(
      readFileSync(path.join(root, "assets/brand/withjz-crew-a.png")),
    );
    expect(existsSync(path.join(root, "assets/brand/withjz-crew-a.svg"))).toBe(true);
  });

  it("does not bundle upstream's managed-stack compose files or web overlay", () => {
    const sources = (packageJson.build.extraResources ?? []).map((entry) => entry.from);
    expect(sources.some((from) => from.includes("compose"))).toBe(false);
    expect(sources.some((from) => from.includes("web/dist"))).toBe(false);
    expect(sources).toContain("../../LICENSE");
  });

  it("turns on the Electron fuses that block code injection into the packaged app", () => {
    expect(packageJson.build.electronFuses).toEqual({
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    });
  });
});

describe("localStackEnabled", () => {
  it("is always off in a packaged build, whatever the environment says", () => {
    expect(localStackEnabled({ packaged: true, env: {} })).toBe(false);
    expect(localStackEnabled({ packaged: true, env: { RAKAZO_ENABLE_LOCAL_STACK: "1" } })).toBe(
      false,
    );
  });

  it("is opt-in for unpackaged development and e2e runs", () => {
    expect(localStackEnabled({ packaged: false, env: {} })).toBe(false);
    expect(localStackEnabled({ packaged: false, env: { RAKAZO_ENABLE_LOCAL_STACK: "true" } })).toBe(
      false,
    );
    expect(localStackEnabled({ packaged: false, env: { RAKAZO_ENABLE_LOCAL_STACK: "1" } })).toBe(
      true,
    );
  });
});

describe("auto-update is off and has no upstream feed", () => {
  it("is disabled at build time", () => {
    expect(AUTO_UPDATE_ENABLED).toBe(false);
  });

  it("publishes nowhere, so electron-builder writes no app-update.yml feed file", () => {
    expect(packageJson.build.publish).toBeNull();
    expect(JSON.stringify(packageJson)).not.toContain("elie222");
  });

  it("does not ship electron-updater at all", () => {
    expect(packageJson.dependencies["electron-updater"]).toBeUndefined();
    expect(packageJson.devDependencies["electron-updater"]).toBeUndefined();
    const main = readFileSync(path.join(root, "src/main.ts"), "utf8");
    expect(main).not.toMatch(/import\s*\(?\s*["']electron-updater["']/);
    expect(main).not.toContain('from "electron-updater"');
  });

  it("schedules no launch or hourly update checks while disabled", () => {
    const main = readFileSync(path.join(root, "src/main.ts"), "utf8");
    expect(main).toContain("if (AUTO_UPDATE_ENABLED && !launchUpdateCheckScheduled)");
    expect(main).toMatch(/disabled: !AUTO_UPDATE_ENABLED \|\|/);
  });
});
