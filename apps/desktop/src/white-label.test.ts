import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = import.meta.dirname;

/** String literals and HTML text; identifiers such as RakazoDesktop or @rakazo/* are internal. */
function userVisibleRakazo(file: string): string[] {
  const text = readFileSync(path.join(src, file), "utf8");
  if (file.endsWith(".html")) {
    const withoutComments = text.replace(/<!--[\s\S]*?-->/g, "");
    return withoutComments.match(/[^\n]*\bRakazo\b[^\n]*/g) ?? [];
  }
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return (
    withoutComments.match(/(["'`])(?:(?!\1)[^\n\\]|\\.)*\bRakazo\b(?:(?!\1)[^\n\\]|\\.)*\1/g) ?? []
  );
}

describe("white-label", () => {
  it.each([
    "setup.html",
    "setup.js",
    "setup-config.ts",
    "main.ts",
    "browser-auth.ts",
    "oauth-callback.ts",
    "auto-update.ts",
    "local-stack.ts",
    "docker-cli.ts",
    "window-options.ts",
  ])("shows no Rakazo product name in %s", (file) => {
    expect(userVisibleRakazo(file)).toEqual([]);
  });

  it("brands the setup window as withJZ Crew and defaults to the existing server", () => {
    const html = readFileSync(path.join(src, "setup.html"), "utf8");
    expect(html).toContain("<title>Set up withJZ Crew</title>");
    expect(html).toContain("Welcome to withJZ Crew");
    expect(html).toMatch(/id="mode-existing"[^>]*checked/);
    expect(html).toMatch(/id="choice-new"[^>]*hidden/);
    expect(html).toContain('placeholder="https://eu-2.tail290516.ts.net"');
  });
});
