import { createHash } from "node:crypto";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { BRAND_LOGO_MAX_BYTES, brandManifest, crc32, UPSTREAM_BRAND } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRAND_API_PATH, createBrandService, mountBrandRoutes } from "./brand.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const OWNER = "user-owner";
const MEMBER = "user-member";

type Row = Record<string, unknown> & { id: string; ownerUserId: string | null };

/** The slice of Prisma the brand service uses, over one in-memory settings row. */
function fakePrisma(row: Row | null = { id: "default", ownerUserId: OWNER }) {
  const state = { row, fail: false };
  const pick = (select?: Record<string, boolean>) => {
    if (!state.row) return null;
    if (!select) return { ...state.row };
    return Object.fromEntries(Object.keys(select).map((key) => [key, state.row?.[key] ?? null]));
  };
  const prisma = {
    deploymentSettings: {
      findUnique: async ({ select }: { select?: Record<string, boolean> }) => {
        if (state.fail) throw new Error("connection reset with secret detail");
        return pick(select);
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; ownerUserId: string };
        data: Record<string, unknown>;
      }) => {
        if (state.fail) throw new Error("connection reset with secret detail");
        if (!state.row || state.row.ownerUserId !== where.ownerUserId) return { count: 0 };
        state.row = { ...state.row, ...data };
        return { count: 1 };
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, state };
}

const u32 = (value: number) => [
  value >>> 24,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
];

/** A PNG whose header is valid; the API never decodes pixels. */
function png(width: number, height: number, padTo = 0): Uint8Array {
  const ihdr = [
    ...Array.from("IHDR", (c) => c.charCodeAt(0)),
    ...u32(width),
    ...u32(height),
    8,
    6,
    0,
    0,
    0,
  ];
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), ...ihdr];
  bytes.push(...u32(crc32(new Uint8Array(ihdr))));
  const out = new Uint8Array(Math.max(bytes.length, padTo));
  out.set(bytes);
  return out;
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function actor(userId: string): Actor {
  return {
    userId,
    spaceId: `space-${userId}`,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: userId === OWNER,
  } as Actor;
}

function setup(options: { env?: Record<string, string>; row?: Row | null; assets?: boolean } = {}) {
  const { prisma, state } = fakePrisma(options.row === undefined ? undefined : options.row);
  const brand = createBrandService({ prisma, env: options.env ?? {}, assets: options.assets });
  const app = new Hono();
  mountBrandRoutes(app, brand);
  const deps = {
    prisma,
    brand,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
      agentRuntime: "scripted",
    },
    dataDir: "/tmp/rakazo-brand-test",
  } as unknown as RouterDeps;
  const rpc = new RPCHandler(createRouter(deps));
  const call = async (who: Actor | null, path: string, body: unknown = null) => {
    const { response } = await rpc.handle(
      new Request(`http://127.0.0.1/rpc/brand/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor: who } },
    );
    const parsed = (await response!.json()) as { json: Record<string, unknown> };
    return { status: response!.status, body: parsed.json };
  };
  return { app, brand, state, call };
}

let sink: ReturnType<typeof createTestSink>;

beforeEach(() => {
  sink = createTestSink();
  installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
});

afterEach(() => {
  installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] }));
});

const denials = () => sink.events.filter((event) => event.message === "brand change denied");

describe("GET /api/v1/brand", () => {
  it("serves the upstream brand without a session when nothing is configured", async () => {
    const { app } = setup();
    const response = await app.request(BRAND_API_PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ...UPSTREAM_BRAND, customLogo: false });
    expect(body.logoUrl).toBe(`${BRAND_API_PATH}/logo?v=${body.version}`);
    expect(body.iconUrl).toBe(body.logoUrl);
  });

  it("resolves stored values over PUBLIC_BRAND_* over upstream", async () => {
    const { app, call } = setup({
      env: { PUBLIC_BRAND_NAME: "Env Crew", PUBLIC_BRAND_TAGLINE: "From env." },
    });
    expect(await (await app.request(BRAND_API_PATH)).json()).toMatchObject({
      name: "Env Crew",
      shortName: "Env Crew",
      tagline: "From env.",
    });
    await call(actor(OWNER), "update", { name: "Db Crew", shortName: "Crew" });
    expect(await (await app.request(BRAND_API_PATH)).json()).toMatchObject({
      name: "Db Crew",
      shortName: "Crew",
      tagline: "From env.",
    });
  });

  it("changes version when the brand changes", async () => {
    const { app, call } = setup();
    const before = ((await (await app.request(BRAND_API_PATH)).json()) as { version: string })
      .version;
    await call(actor(OWNER), "uploadLogo", { data: base64(png(128, 128)) });
    const after = (await (await app.request(BRAND_API_PATH)).json()) as {
      version: string;
      customLogo: boolean;
    };
    expect(after.customLogo).toBe(true);
    expect(after.version).not.toBe(before);
  });

  it("hides internal errors behind an error id and logs the details", async () => {
    const { app, state } = setup();
    state.fail = true;
    const response = await app.request(BRAND_API_PATH);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; error_id: string };
    expect(body.error).toBe("Internal error");
    expect(JSON.stringify(body)).not.toContain("secret detail");
    const logged = sink.events.find((event) => event["error.id"] === body.error_id);
    expect(logged?.level).toBe("error");
  });
});

describe("GET /api/v1/brand/logo", () => {
  const securityHeaders = (response: Response) => {
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(response.headers.get("content-disposition")).toBe("inline");
  };

  it("serves the uploaded bytes with the sniffed type, an ETag and security headers", async () => {
    const { app, call } = setup();
    const bytes = png(256, 128, 600);
    await call(actor(OWNER), "uploadLogo", { data: base64(bytes) });
    const { version } = (await (await app.request(BRAND_API_PATH)).json()) as { version: string };

    const response = await app.request(`${BRAND_API_PATH}/logo`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(response.headers.get("etag")).toBe(`"${sha}"`);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    securityHeaders(response);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);

    const versioned = await app.request(`${BRAND_API_PATH}/logo?v=${version}`);
    expect(versioned.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    const revalidated = await app.request(`${BRAND_API_PATH}/logo`, {
      headers: { "if-none-match": `"${sha}"` },
    });
    expect(revalidated.status).toBe(304);
  });

  it("generates a monogram for a white-labelled deployment without an upload", async () => {
    const { app } = setup({ env: { PUBLIC_BRAND_NAME: "<script>alert(1)</script>" } });
    const response = await app.request(`${BRAND_API_PATH}/logo`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    securityHeaders(response);
    const svg = await response.text();
    expect(svg).toContain(">&lt;</text>");
    expect(svg).not.toContain("<script");
  });

  it("points at the upstream icon when the deployment is not white-labelled", async () => {
    const { app } = setup();
    const response = await app.request(`${BRAND_API_PATH}/logo`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/icon-512.png");
  });

  it("points at the web app's icon when PUBLIC_BRAND_ASSETS_DIR replaced it", async () => {
    const { app } = setup({ env: { PUBLIC_BRAND_NAME: "Acme" }, assets: true });
    const response = await app.request(`${BRAND_API_PATH}/logo`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/icon-512.png");
    const manifest = (await (
      await app.request(`${BRAND_API_PATH}/manifest.webmanifest`)
    ).json()) as ReturnType<typeof brandManifest>;
    expect(manifest).toMatchObject({ name: "Acme" });
    expect(manifest.icons).toEqual(brandManifest(UPSTREAM_BRAND).icons);
  });
});

describe("GET /api/v1/brand/manifest.webmanifest", () => {
  it("equals the upstream manifest when nothing is configured", async () => {
    const { app } = setup();
    const response = await app.request(`${BRAND_API_PATH}/manifest.webmanifest`);
    expect(response.headers.get("content-type")).toBe("application/manifest+json");
    expect(await response.json()).toEqual(brandManifest(UPSTREAM_BRAND));
  });

  it("names the brand and points its icons at the logo endpoint", async () => {
    const { app, call } = setup();
    await call(actor(OWNER), "update", { name: "Acme Crew", shortName: "Crew", tagline: "Hi." });
    const monogram = (await (
      await app.request(`${BRAND_API_PATH}/manifest.webmanifest`)
    ).json()) as ReturnType<typeof brandManifest>;
    expect(monogram).toMatchObject({ name: "Acme Crew", short_name: "Crew", description: "Hi." });
    expect(monogram.icons).toEqual([
      {
        src: expect.stringMatching(/^\/api\/v1\/brand\/logo\?v=/),
        sizes: "any",
        type: "image/svg+xml",
      },
    ]);

    await call(actor(OWNER), "uploadLogo", { data: base64(png(512, 256)) });
    const uploaded = (await (
      await app.request(`${BRAND_API_PATH}/manifest.webmanifest`)
    ).json()) as ReturnType<typeof brandManifest>;
    expect(uploaded.icons).toEqual([
      {
        src: expect.stringMatching(/^\/api\/v1\/brand\/logo\?v=/),
        sizes: "512x256",
        type: "image/png",
      },
    ]);
  });
});

describe("brand mutations", () => {
  it("lets the deployment owner update text, upload and remove the logo", async () => {
    const { call, state } = setup();
    const updated = await call(actor(OWNER), "update", {
      name: "  Acme Crew ",
      shortName: "",
      tagline: "Agents.",
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      brand: { name: "Acme Crew", shortName: "Acme Crew", tagline: "Agents." },
      stored: { name: "Acme Crew", shortName: null, tagline: "Agents." },
    });
    expect(state.row?.brandUpdatedBy).toBe(OWNER);

    const uploaded = await call(actor(OWNER), "uploadLogo", { data: base64(png(64, 64)) });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body).toMatchObject({ brand: { customLogo: true } });
    expect(state.row?.brandLogoMime).toBe("image/png");

    const removed = await call(actor(OWNER), "removeLogo");
    expect(removed.body).toMatchObject({ brand: { customLogo: false } });
    expect(state.row?.brandLogo).toBeNull();
    expect(denials()).toEqual([]);
  });

  it("denies a space member who is not the deployment owner, and logs it", async () => {
    const { call, state } = setup();
    for (const [path, body] of [
      ["update", { name: "Hijacked" }],
      ["uploadLogo", { data: base64(png(64, 64)) }],
      ["removeLogo", null],
      ["settings", null],
    ] as const) {
      const response = await call(actor(MEMBER), path, body);
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(state.row?.brandName).toBeUndefined();
    expect(denials().map((event) => [event["user.id"], event.action])).toEqual([
      [MEMBER, "brand.update"],
      [MEMBER, "brand.uploadLogo"],
      [MEMBER, "brand.removeLogo"],
      [MEMBER, "brand.settings"],
    ]);
    expect(denials().every((event) => event.level === "warn")).toBe(true);
  });

  it("denies an unauthenticated caller, and logs it", async () => {
    const { call } = setup();
    const response = await call(null, "update", { name: "Anon" });
    expect(response.status).toBe(403);
    expect(denials()).toMatchObject([{ "user.id": "anonymous", action: "brand.update" }]);
  });

  it("ignores an owner id forged in the request body", async () => {
    const { call, state } = setup();
    const response = await call(actor(MEMBER), "update", {
      name: "Forged",
      ownerUserId: MEMBER,
      userId: OWNER,
    });
    expect(response.status).toBe(403);
    expect(state.row?.ownerUserId).toBe(OWNER);
    expect(state.row?.brandName).toBeUndefined();
  });

  it("denies everyone when the deployment has no owner yet", async () => {
    const { call } = setup({ row: null });
    expect((await call(actor(OWNER), "update", { name: "Acme" })).status).toBe(403);
  });

  it("rejects invalid text with a reason", async () => {
    const { call, state } = setup();
    for (const [body, reason] of [
      [{ name: "a".repeat(61) }, "name_too_long"],
      [{ shortName: "b".repeat(61) }, "shortName_too_long"],
      [{ tagline: "t".repeat(141) }, "tagline_too_long"],
      [{ name: "Line\nbreak" }, "control_characters"],
    ] as const) {
      const response = await call(actor(OWNER), "update", body);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: "BAD_REQUEST", data: { reason } });
    }
    expect(state.row?.brandName).toBeUndefined();
  });

  it("checks uploads by content: type, header, size and dimensions", async () => {
    const { call, state } = setup();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const gif = new TextEncoder().encode("GIF89a@\u0000@\u0000");
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff]);
    for (const [bytes, reason] of [
      [svg, "unsupported_type"],
      [gif, "unsupported_type"],
      [exe, "unsupported_type"],
      [png(128, 128).slice(0, 20), "corrupt"],
      [png(63, 128), "dimensions"],
      [png(4097, 128), "dimensions"],
      [png(8000, 8000), "dimensions"],
      [png(128, 128, BRAND_LOGO_MAX_BYTES + 1), "too_large"],
      [new Uint8Array(), "empty"],
    ] as const) {
      const response = await call(actor(OWNER), "uploadLogo", { data: base64(bytes) });
      expect(response.status, reason).toBe(400);
      expect(response.body).toMatchObject({ data: { reason } });
    }
    const notBase64 = await call(actor(OWNER), "uploadLogo", { data: "%%%not base64%%%" });
    expect(notBase64.body).toMatchObject({ code: "BAD_REQUEST", data: { reason: "corrupt" } });
    expect(state.row?.brandLogo).toBeUndefined();

    const dataUrl = `data:image/jpeg;base64,${base64(png(4096, 64))}`;
    const accepted = await call(actor(OWNER), "uploadLogo", { data: dataUrl });
    expect(accepted.status).toBe(200);
    // Stored as what the bytes are, not what the data URL claimed.
    expect(state.row?.brandLogoMime).toBe("image/png");
  });

  it("returns a generic error with an id when storage fails", async () => {
    const { call, state } = setup();
    state.fail = true;
    const response = await call(actor(OWNER), "update", { name: "Acme" });
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal error",
      data: { error_id: expect.any(String) },
    });
    expect(JSON.stringify(response.body)).not.toContain("secret detail");
    const errorId = (response.body.data as { error_id: string }).error_id;
    expect(sink.events.some((event) => event["error.id"] === errorId)).toBe(true);
  });

  it("refreshes the server-side brand name after a change", async () => {
    const { call, brand } = setup();
    expect(await brand.reader.name()).toBe(UPSTREAM_BRAND.name);
    await call(actor(OWNER), "update", { name: "Acme Crew" });
    expect(await brand.reader.name()).toBe("Acme Crew");
  });
});
