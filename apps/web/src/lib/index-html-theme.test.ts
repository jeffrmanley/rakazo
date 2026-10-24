import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { darkTokens, lightTokens } from "@rakazo/ui-tokens";
import { describe, expect, it } from "vitest";

// index.html sets theme-color before any module loads, so neither it nor the classic script it
// runs first (public/theme-init.js) can import the tokens; this pins their fallbacks to the
// shared palette instead.
describe("index.html theme bootstrap", () => {
  const read = (path: string) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  const html = read("../../index.html");
  const script = read("../../public/theme-init.js");

  it("uses the shared background tokens for theme-color", () => {
    expect(html).toContain(
      `<meta name="theme-color" content="${darkTokens.background.toLowerCase()}" />`,
    );
    expect(script).toContain(
      `theme === "light" ? "${lightTokens.background.toLowerCase()}" : "${darkTokens.background.toLowerCase()}"`,
    );
  });

  it("runs the bootstrap from a file in <head>, with no inline script for the CSP to refuse", () => {
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).toContain('<script src="/theme-init.js"></script>');
    expect(head.indexOf('<meta name="theme-color"')).toBeLessThan(head.indexOf("theme-init.js"));
    // Before any module: zod must be jitless before the first schema is built.
    expect(head).toContain('<script src="/zod-jitless.js"></script>');
    const inline = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].filter(([, body]) =>
      body?.trim(),
    );
    expect(inline).toEqual([]);
  });
});
