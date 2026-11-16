import { describe, expect, it } from "vitest";
import {
  appNavigationDecision,
  httpOriginOf,
  isTrustedAppFrame,
  popupWindowOpenTarget,
} from "./navigation-policy.js";

const server = "https://eu-2.tail290516.ts.net";

describe("httpOriginOf", () => {
  it("returns http(s) origins and rejects opaque or malformed values", () => {
    expect(httpOriginOf(`${server}/login?x=1`)).toBe(server);
    expect(httpOriginOf("http://127.0.0.1:45173/")).toBe("http://127.0.0.1:45173");
    expect(httpOriginOf("data:text/html,hi")).toBeNull();
    expect(httpOriginOf("file:///C:/evil.html")).toBeNull();
    expect(httpOriginOf("about:blank")).toBeNull();
    expect(httpOriginOf("javascript:alert(1)")).toBeNull();
    expect(httpOriginOf("not a url")).toBeNull();
    expect(httpOriginOf(undefined)).toBeNull();
  });
});

describe("appNavigationDecision", () => {
  it("keeps same-origin navigations and redirects in the app window", () => {
    expect(appNavigationDecision(server, `${server}/two-factor`)).toEqual({ allow: true });
    expect(appNavigationDecision(`${server}/`, `${server}/login`)).toEqual({ allow: true });
  });

  it("sends cross-origin http(s) targets to the system browser", () => {
    expect(appNavigationDecision(server, "https://accounts.google.com/o/oauth2/auth")).toEqual({
      allow: false,
      external: "https://accounts.google.com/o/oauth2/auth",
    });
  });

  it("treats a lookalike host, another port or a scheme downgrade as foreign", () => {
    for (const url of [
      "https://eu-2.tail290516.ts.net.evil.example/",
      "https://eu-2.tail290516.ts.net:8443/",
      "http://eu-2.tail290516.ts.net/",
      "https://evil.example/?next=https://eu-2.tail290516.ts.net",
    ]) {
      expect(appNavigationDecision(server, url).allow, url).toBe(false);
    }
  });

  it("blocks non-http targets without opening them anywhere", () => {
    for (const url of [
      "file:///C:/Windows/System32/calc.exe",
      "javascript:alert(1)",
      "ms-settings:",
    ]) {
      expect(appNavigationDecision(server, url)).toEqual({ allow: false, external: null });
    }
  });

  it("never treats two opaque origins as the same origin", () => {
    expect(appNavigationDecision("data:text/html,a", "data:text/html,b").allow).toBe(false);
  });
});

describe("isTrustedAppFrame", () => {
  it("accepts only a top frame on the configured server origin", () => {
    expect(isTrustedAppFrame(`${server}/settings`, server)).toBe(true);
    expect(isTrustedAppFrame("https://evil.example/", server)).toBe(false);
    expect(isTrustedAppFrame("data:text/html,x", server)).toBe(false);
    expect(isTrustedAppFrame(`${server}/`, null)).toBe(false);
    expect(isTrustedAppFrame(undefined, server)).toBe(false);
  });
});

describe("popupWindowOpenTarget", () => {
  it("only hands http(s) links to the system browser", () => {
    expect(popupWindowOpenTarget("https://provider.example/help")).toBe(
      "https://provider.example/help",
    );
    expect(popupWindowOpenTarget("file:///etc/passwd")).toBeNull();
    expect(popupWindowOpenTarget("smb://host/share")).toBeNull();
  });
});
