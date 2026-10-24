#!/usr/bin/env node
// Checks the web front end's security headers against a running stack (hardening phase 1, S2).
//
//   node infra/compose/check-web-headers.mjs [origin]     default http://127.0.0.1:5173
//
// Asserts every required header and CSP directive on the app's documents and files, the caching
// rules, that proxied API and screen-proxy responses keep their own policies, and grades the
// header set with a subset of the Mozilla HTTP Observatory rules (must be A or better).
// Exits non-zero on any failure. Needs Node 22 (fetch, WebSocket); reads nothing but the origin.
import net from "node:net";

const origin = new URL(process.argv[2] ?? "http://127.0.0.1:5173").origin;
const failures = [];
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(label);
};

async function get(path, init = {}) {
  const response = await fetch(new URL(path, origin), { redirect: "manual", ...init });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

function parseCsp(value) {
  const directives = new Map();
  for (const part of (value ?? "").split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/).filter(Boolean);
    if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

const sameSet = (actual, expected) =>
  actual !== undefined &&
  actual.length === expected.length &&
  expected.every((source) => actual.includes(source));

function checkAppCsp(label, headers) {
  const csp = parseCsp(headers.get("content-security-policy"));
  const expect = (name, sources) =>
    check(
      sameSet(csp.get(name), sources),
      `${label}: CSP ${name} ${sources.join(" ")}`,
      `got ${csp.get(name)?.join(" ") ?? "nothing"}`,
    );
  expect("default-src", ["'self'"]);
  expect("script-src", ["'self'"]);
  expect("style-src", ["'self'", "'unsafe-inline'"]);
  expect("img-src", ["'self'", "data:", "blob:", "https:"]);
  expect("object-src", ["'none'"]);
  expect("frame-ancestors", ["'none'"]);
  expect("base-uri", ["'self'"]);
  expect("form-action", ["'self'"]);
  const connect = csp.get("connect-src") ?? [];
  check(
    connect.includes("'self'") &&
      connect.every((s) => s === "'self'" || /^wss:\/\/[^*\s]+$/.test(s)),
    `${label}: CSP connect-src is 'self' plus the wss origin`,
    connect.join(" "),
  );
  const frames = csp.get("frame-src") ?? [];
  check(
    frames.length > 0 && frames.every((s) => s === "'self'" || s === "blob:"),
    `${label}: CSP frame-src limited to 'self' (screens, artifact frame) and blob: (PDFs)`,
    frames.join(" "),
  );
  check(
    !headers.has("content-security-policy-report-only"),
    `${label}: CSP enforced, not report-only`,
  );
}

function checkBaseHeaders(label, headers) {
  const maxAge = Number(/max-age=(\d+)/.exec(headers.get("strict-transport-security") ?? "")?.[1]);
  check(maxAge >= 31_536_000, `${label}: Strict-Transport-Security max-age >= 1 year`);
  check(headers.get("x-content-type-options") === "nosniff", `${label}: X-Content-Type-Options`);
}

function checkAppHeaders(label, headers) {
  checkBaseHeaders(label, headers);
  checkAppCsp(label, headers);
  check(
    headers.get("referrer-policy") === "strict-origin-when-cross-origin",
    `${label}: Referrer-Policy strict-origin-when-cross-origin`,
  );
  const permissions = (headers.get("permissions-policy") ?? "").split(",").map((s) => s.trim());
  for (const feature of ["camera=()", "geolocation=()", "payment=()", "microphone=(self)"]) {
    check(permissions.includes(feature), `${label}: Permissions-Policy ${feature}`);
  }
  check(
    ["same-origin", "same-origin-allow-popups"].includes(headers.get("cross-origin-opener-policy")),
    `${label}: Cross-Origin-Opener-Policy`,
    headers.get("cross-origin-opener-policy") ?? "missing",
  );
}

/** A subset of the Mozilla HTTP Observatory scoring (the tests a header set decides). */
function observatoryScore(headers) {
  let score = 100;
  const bonuses = [];
  const csp = parseCsp(headers.get("content-security-policy"));
  if (csp.size === 0) score -= 25;
  else {
    const script = csp.get("script-src") ?? csp.get("default-src") ?? ["*"];
    const style = csp.get("style-src") ?? csp.get("default-src") ?? ["*"];
    const objects = csp.get("object-src") ?? csp.get("default-src") ?? ["*"];
    const unsafe = (sources) =>
      sources.some((s) => ["'unsafe-inline'", "data:", "http:", "https:", "*"].includes(s));
    if (unsafe(script) || !objects.includes("'none'")) score -= 20;
    else if (script.includes("'unsafe-eval'")) score -= 10;
    else if (!unsafe(style)) bonuses.push(csp.get("default-src")?.includes("'none'") ? 10 : 5);
  }
  const hstsAge = Number(/max-age=(\d+)/.exec(headers.get("strict-transport-security") ?? "")?.[1]);
  if (!headers.has("strict-transport-security")) score -= 20;
  else if (!(hstsAge >= 15_768_000)) score -= 10;
  if (headers.get("x-content-type-options") !== "nosniff") score -= 5;
  const ancestors = csp.get("frame-ancestors");
  if (ancestors?.includes("'none'") || ancestors?.includes("'self'")) bonuses.push(5);
  else if (!["DENY", "SAMEORIGIN"].includes((headers.get("x-frame-options") ?? "").toUpperCase()))
    score -= 20;
  const referrer = headers.get("referrer-policy") ?? "";
  if (
    ["no-referrer", "same-origin", "strict-origin", "strict-origin-when-cross-origin"].includes(
      referrer,
    )
  )
    bonuses.push(5);
  else if (["origin-when-cross-origin", "unsafe-url"].includes(referrer)) score -= 5;
  // As in the Observatory, bonuses only lift a score that is already 90 or more.
  if (score >= 90) score += bonuses.reduce((sum, bonus) => sum + bonus, 0);
  const grades = [
    [100, "A+"],
    [90, "A"],
    [85, "A-"],
    [80, "B+"],
    [70, "B"],
    [65, "B-"],
    [60, "C+"],
    [50, "C"],
    [45, "C-"],
    [40, "D+"],
    [30, "D"],
    [25, "D-"],
  ];
  return { score, grade: grades.find(([min]) => score >= min)?.[1] ?? "F" };
}

/** True when a raw websocket upgrade is answered 101; the screen proxy must refuse a bad capability. */
function websocketUpgrades(path) {
  const url = new URL(path, origin);
  return new Promise((resolve) => {
    const socket = net.connect(Number(url.port || 80), url.hostname, () => {
      socket.write(
        `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    let head = "";
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on("data", (chunk) => {
      head += chunk.toString("latin1");
      if (head.includes("\r\n")) socket.destroy();
    });
    socket.on("close", () => resolve(/^HTTP\/1\.1 101/.test(head)));
    socket.on("error", () => resolve(false));
  });
}

async function main() {
  console.log(`web front end: ${origin}`);

  for (const path of ["/", "/settings/branding", "/index.html"]) {
    const page = await get(path, { headers: { accept: "text/html" } });
    check(page.status === 200, `${path}: 200`, String(page.status));
    check(/^text\/html/.test(page.headers.get("content-type") ?? ""), `${path}: text/html`);
    check(page.headers.get("cache-control") === "no-store", `${path}: Cache-Control no-store`);
    check(page.headers.get("x-frame-options") === "DENY", `${path}: X-Frame-Options DENY`);
    checkAppHeaders(path, page.headers);
  }

  const index = await get("/");
  const inline = [...index.body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(
    ([, attributes, body]) => body.trim() !== "" && !/type="application\/json"/.test(attributes),
  );
  check(inline.length === 0, "index.html: no inline executable scripts", `${inline.length} found`);
  const grade = observatoryScore(index.headers);
  check(
    ["A+", "A"].includes(grade.grade),
    `Observatory-style grade ${grade.grade} (${grade.score}), A or better`,
  );

  const asset = /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(index.body)?.[1];
  check(Boolean(asset), "index.html: references a hashed /assets/ script");
  if (asset) {
    const file = await get(asset);
    check(file.status === 200, `${asset}: 200`);
    check(
      /javascript/.test(file.headers.get("content-type") ?? ""),
      `${asset}: JavaScript content type`,
    );
    check(
      file.headers.get("cache-control") === "public, max-age=31536000, immutable",
      `${asset}: immutable for a year`,
      file.headers.get("cache-control") ?? "missing",
    );
    checkAppHeaders(asset, file.headers);
  }
  const theme = await get("/theme-init.js");
  check(theme.status === 200, "/theme-init.js: 200");
  check(
    theme.headers.get("cache-control") === "no-cache",
    "/theme-init.js: revalidated, not immutable",
  );

  const frame = await get("/html-preview.html");
  const frameCsp = parseCsp(frame.headers.get("content-security-policy"));
  check(frame.status === 200, "/html-preview.html: 200");
  check(
    sameSet(frameCsp.get("sandbox"), ["allow-scripts"]),
    "/html-preview.html: CSP sandbox allow-scripts",
  );
  check(
    sameSet(frameCsp.get("default-src"), ["'none'"]),
    "/html-preview.html: CSP default-src 'none'",
  );
  check(
    sameSet(frameCsp.get("frame-ancestors"), ["'self'"]),
    "/html-preview.html: framed by the app only",
  );
  check(!/allow-same-origin/.test(frame.body), "/html-preview.html: never allow-same-origin");
  checkBaseHeaders("/html-preview.html", frame.headers);

  // An uploaded logo is served by the api with its own CSP; without one it redirects to the
  // static icon. Either way the front end must not swap in the app's policy.
  const logo = await get("/api/v1/brand/logo");
  if (logo.status === 200) {
    check(
      logo.headers.get("content-security-policy") === "default-src 'none'",
      "/api/v1/brand/logo: the api's own CSP is kept",
      logo.headers.get("content-security-policy") ?? "missing",
    );
  } else {
    check(
      logo.status === 302,
      "/api/v1/brand/logo: redirects to the static icon",
      String(logo.status),
    );
    check(
      !logo.headers.has("content-security-policy"),
      "/api/v1/brand/logo: no app CSP on API responses",
    );
  }
  checkBaseHeaders("/api/v1/brand/logo", logo.headers);
  const brand = await get("/api/v1/brand");
  check(
    brand.status === 200 && /json/.test(brand.headers.get("content-type") ?? ""),
    "/api/v1/brand: proxied JSON",
  );
  check(
    !brand.headers.has("content-security-policy"),
    "/api/v1/brand: no app CSP on API responses",
  );
  check(brand.headers.get("x-frame-options") === "DENY", "/api/v1/brand: X-Frame-Options DENY");
  const rpc = await get("/rpc/health-check-probe", { method: "POST" });
  check(rpc.status !== 502 && rpc.status !== 504, "/rpc: proxied to the api", String(rpc.status));

  const screen = await get("/novnc/session/view/0.invalid/vnc.html");
  check(
    screen.status === 403,
    "/novnc/: answered by the screen proxy (403 for a bad capability)",
    String(screen.status),
  );
  check(
    !/frame-ancestors 'none'/.test(screen.headers.get("content-security-policy") ?? ""),
    "/novnc/: app CSP not applied",
  );
  check(!screen.headers.has("x-frame-options"), "/novnc/: stays frameable by the app");
  check(
    /frame-ancestors 'self'/.test(screen.headers.get("content-security-policy") ?? ""),
    "/novnc/: only this origin may frame a screen",
  );
  check(
    !(await websocketUpgrades("/novnc/session/view/0.invalid/websockify")),
    "/novnc/: websocket refused for a bad capability",
  );

  const probe = await get("/.well-known/rakazo-desktop-stack");
  check(
    probe.status === 404,
    "desktop stack probe: answered by web-app (404 without the token)",
    String(probe.status),
  );

  console.log(
    failures.length ? `\n${failures.length} check(s) failed` : "\nall web header checks passed",
  );
  process.exit(failures.length ? 1 : 0);
}

await main();
