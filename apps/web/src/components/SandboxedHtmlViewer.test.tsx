// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  HTML_PREVIEW_FRAME_URL,
  HTML_PREVIEW_MESSAGE,
  SandboxedHtmlViewer,
} from "./SandboxedHtmlViewer";

const FRAME_HTML = readFileSync(
  path.resolve(import.meta.dirname, "../../public", HTML_PREVIEW_FRAME_URL.slice(1)),
  "utf8",
);

async function render(html: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SandboxedHtmlViewer title="Notes" html={html} />);
  });
  const iframe = container.querySelector("iframe");
  if (!iframe?.contentWindow) throw new Error("preview iframe missing");
  const postMessage = vi.spyOn(iframe.contentWindow, "postMessage").mockImplementation(() => {});
  return {
    iframe,
    postMessage,
    /** The preview documents posted to the frame so far. */
    posted: () =>
      postMessage.mock.calls.map(([message, target]) => {
        expect(target).toBe("*");
        expect(message).toMatchObject({ type: HTML_PREVIEW_MESSAGE });
        return (message as { html: string }).html;
      }),
    async load() {
      await act(async () => {
        iframe.dispatchEvent(new Event("load"));
      });
    },
    async rerender(next: string) {
      await act(async () => {
        root.render(<SandboxedHtmlViewer title="Notes" html={next} />);
      });
    },
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

it("keeps the preview frame opaque and loads it from its own URL, not a srcdoc", async () => {
  const view = await render("<p>Hello</p>");

  expect(view.iframe.getAttribute("src")).toBe("/html-preview.html");
  expect(view.iframe.getAttribute("sandbox")).toBe("allow-scripts");
  expect(view.iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(view.iframe.hasAttribute("srcdoc")).toBe(false);

  await view.cleanup();
});

it("posts the preview once the frame loads, with remote images and fonts blocked", async () => {
  const view = await render(
    '<img src="https://example.invalid/pixel.png"><style>@font-face { src: url(https://example.invalid/font.woff); }</style>',
  );
  expect(view.posted()).toEqual([]);

  await view.load();
  const [document] = view.posted();
  expect(document).toContain("img-src data:");
  expect(document).toContain("font-src data:");
  expect(document).not.toMatch(/img-src[^;]*https:/);
  expect(document).not.toMatch(/font-src[^;]*https:/);
  expect(document).toContain('<meta name="referrer" content="no-referrer">');
  // The click/submit guard runs before the bot's markup.
  expect(document?.indexOf("event.preventDefault()")).toBeLessThan(
    document?.indexOf("https://example.invalid/pixel.png") ?? -1,
  );

  await view.cleanup();
});

it("re-posts when the HTML changes or the frame reloads", async () => {
  const view = await render("<p>One</p>");
  await view.load();
  await view.rerender("<p>Two</p>");
  await view.load();

  const posted = view.posted();
  expect(posted).toHaveLength(3);
  expect(posted[0]).toContain("<p>One</p>");
  expect(posted[1]).toContain("<p>Two</p>");
  expect(posted[2]).toContain("<p>Two</p>");

  await view.cleanup();
});

it("the frame renders posted HTML in a nested opaque sandbox and only listens to its parent", () => {
  const frame = new DOMParser().parseFromString(FRAME_HTML, "text/html");
  const inner = frame.querySelectorAll("iframe");
  expect(inner).toHaveLength(1);
  expect(inner[0]?.getAttribute("sandbox")).toBe("allow-scripts");
  expect(inner[0]?.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(inner[0]?.getAttribute("csp")).toContain("img-src data:");
  expect(FRAME_HTML).not.toContain("allow-same-origin");

  const script = frame.querySelector("script")?.textContent ?? "";
  expect(script).toContain("event.source !== parent");
  expect(script).toContain(`"${HTML_PREVIEW_MESSAGE}"`);
  expect(script).toContain('typeof message.html !== "string"');
  expect(script).toContain(".srcdoc = message.html");
});

it("lets the frame load the nested srcdoc preview and rejects http(s) navigations", () => {
  const sources = operativeFrameSources(frameContentSecurityPolicy(FRAME_HTML));

  expect(frameSourceAllows(sources, "about:srcdoc")).toBe(true);
  expect(frameSourceAllows(sources, "https://example.invalid/nav")).toBe(false);
  expect(frameSourceAllows(sources, "http://example.invalid/nav")).toBe(false);
  expect(frameContentSecurityPolicy(FRAME_HTML)).toContain("child-src 'none'");
  expect(frameContentSecurityPolicy(FRAME_HTML)).toMatch(/default-src 'none'/);
});

function frameContentSecurityPolicy(html: string): string {
  const match = html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/);
  if (!match?.[1]) throw new Error("frame CSP missing");
  return match[1];
}

function directiveSources(policy: string, name: string): string[] | undefined {
  for (const part of policy.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens[0] !== name) continue;
    return tokens.slice(1);
  }
  return undefined;
}

function operativeFrameSources(policy: string): string[] {
  return (
    directiveSources(policy, "frame-src") ??
    directiveSources(policy, "child-src") ??
    directiveSources(policy, "default-src") ?? ["'none'"]
  );
}

function frameSourceAllows(sources: string[], rawUrl: string): boolean {
  if (sources.length === 0 || sources.includes("'none'")) return false;
  const url = new URL(rawUrl);
  return sources.some((source) => sourceAllows(source, url));
}

function sourceAllows(source: string, url: URL): boolean {
  if (source === "*") {
    return (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "ws:" ||
      url.protocol === "wss:"
    );
  }
  if (source.startsWith("'")) return false;
  if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) return url.protocol === source;
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const allowed = new URL(source);
    return url.protocol === allowed.protocol && url.hostname === allowed.hostname;
  }
  return false;
}
