import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * main.ts needs a running Electron to execute, so these checks pin its security wiring at
 * the source level. The behavior behind each wire is unit-tested in navigation-policy,
 * session-permissions, window-open and auto-update-disabled.
 */
const main = readFileSync(path.resolve(import.meta.dirname, "main.ts"), "utf8");

function browserWindowBlocks() {
  const blocks: string[] = [];
  let index = main.indexOf("new BrowserWindow(");
  while (index !== -1) {
    let depth = 0;
    let end = index + "new BrowserWindow".length;
    for (; end < main.length; end++) {
      if (main[end] === "(") depth++;
      if (main[end] === ")" && --depth === 0) break;
    }
    blocks.push(main.slice(index, end + 1));
    index = main.indexOf("new BrowserWindow(", end);
  }
  return blocks;
}

describe("Electron hardening in main.ts", () => {
  it("creates every window isolated, sandboxed and without Node", () => {
    const blocks = browserWindowBlocks();
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const block of blocks) {
      expect(block).toContain("nodeIntegration: false");
      expect(block).toContain("contextIsolation: true");
      expect(block).toContain("sandbox: true");
    }
  });

  it("never weakens web security", () => {
    for (const unsafe of [
      "webSecurity: false",
      "allowRunningInsecureContent",
      "nodeIntegrationInSubFrames",
      "nodeIntegrationInWorker",
      "webviewTag: true",
      "experimentalFeatures",
      "enableBlinkFeatures",
      "contextIsolation: false",
      "sandbox: false",
    ]) {
      expect(main, unsafe).not.toContain(unsafe);
    }
  });

  it("keeps the app window's top frame on the server origin for navigations and redirects", () => {
    expect(main).toMatch(
      /on\("will-navigate", \(event, navigationUrl\) => \{\s+const decision = appNavigationDecision\(url, navigationUrl\);/,
    );
    expect(main).toMatch(
      /on\("will-redirect", \(details\) => \{\s+if \(!details\.isMainFrame\) return;\s+const decision = appNavigationDecision\(url, details\.url\);/,
    );
  });

  it("denies window.open by default in every window it creates", () => {
    // App window (allow-list), setup, local settings, and sign-in popups.
    expect(main.match(/setWindowOpenHandler\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(main).toContain("popup.webContents.setWindowOpenHandler(");
  });

  it("keeps the setup window from navigating", () => {
    expect(main).toContain(
      'win.webContents.on("will-navigate", (event) => event.preventDefault());',
    );
  });

  it("blocks <webview> in every WebContents", () => {
    expect(main).toMatch(
      /app\.on\("web-contents-created", \(_event, contents\) => \{\s+contents\.on\("will-attach-webview", \(event\) => event\.preventDefault\(\)\);/,
    );
  });

  it("installs permission handlers on every session before it loads content", () => {
    expect(main).toContain(
      'app.on("session-created", (value) => installSessionPermissions(value, permissionTarget));',
    );
    expect(main).toContain("installSessionPermissions(session.defaultSession, permissionTarget);");
  });

  it("answers privileged IPC only from the app's top frame on its server origin", () => {
    for (const channel of [
      "desktop.oauth.open",
      "desktop.oauth.cancel",
      "desktop.update.check",
      "desktop.update.download",
      "desktop.update.install",
    ]) {
      const start = main.indexOf(`ipcMain.handle("${channel}"`);
      expect(start, channel).toBeGreaterThan(-1);
      const handler = main.slice(start, start + 400);
      expect(handler, channel).toContain("fromTrustedAppFrame(event)");
    }
    expect(main).toMatch(
      /function fromTrustedAppFrame[\s\S]+?frame !== event\.sender\.mainFrame[\s\S]+?isTrustedAppFrame\(frame\.url, appWindowTargets\.get\(mainWindow\)\)/,
    );
  });
});
