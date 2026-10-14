import { createHash } from "node:crypto";
import { UPSTREAM_BRAND } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBrandReader,
  readBrandLogo,
  readBrandSettings,
  removeBrandLogo,
  saveBrandLogo,
  saveBrandText,
} from "./brand-settings.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("runtime brand settings (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const ownerId = `brand-owner-${suffix}`;
  const otherId = `brand-other-${suffix}`;
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let previous: { ownerUserId: string | null } | null;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    previous = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { ownerUserId: true },
    });
    await prisma.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ownerUserId: ownerId },
      update: { ownerUserId: ownerId },
    });
  });

  afterAll(async () => {
    await prisma.deploymentSettings.update({
      where: { id: "default" },
      data: {
        ownerUserId: previous?.ownerUserId ?? null,
        brandName: null,
        brandShortName: null,
        brandTagline: null,
        brandLogo: null,
        brandLogoMime: null,
        brandLogoSha256: null,
        brandUpdatedAt: null,
        brandUpdatedBy: null,
      },
    });
    await close();
  });

  it("persists text and a logo, and reads them back", async () => {
    const saved = await saveBrandText(
      prisma,
      { name: "Acme Crew", shortName: "Crew", tagline: "Agents for Acme." },
      ownerId,
    );
    expect(saved).toMatchObject({
      name: "Acme Crew",
      shortName: "Crew",
      tagline: "Agents for Acme.",
      logoSha256: null,
      updatedBy: ownerId,
    });
    expect(saved?.updatedAt).toBeInstanceOf(Date);

    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const withLogo = await saveBrandLogo(prisma, { bytes, mime: "image/png" }, ownerId);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(withLogo).toMatchObject({
      name: "Acme Crew",
      logoMime: "image/png",
      logoSha256: sha256,
    });

    const logo = await readBrandLogo(prisma);
    expect(logo?.mime).toBe("image/png");
    expect(logo?.sha256).toBe(sha256);
    expect(Array.from(logo!.bytes)).toEqual(Array.from(bytes));

    // A partial update leaves the other fields alone; null clears one.
    await saveBrandText(prisma, { tagline: null }, ownerId);
    expect(await readBrandSettings(prisma)).toMatchObject({
      name: "Acme Crew",
      shortName: "Crew",
      tagline: null,
      logoSha256: sha256,
    });
  });

  it("removes the logo and keeps the text", async () => {
    const removed = await removeBrandLogo(prisma, ownerId);
    expect(removed).toMatchObject({ name: "Acme Crew", logoMime: null, logoSha256: null });
    expect(await readBrandLogo(prisma)).toBeNull();
  });

  it("writes only for the deployment owner", async () => {
    expect(await saveBrandText(prisma, { name: "Hijacked" }, otherId)).toBeNull();
    expect(
      await saveBrandLogo(prisma, { bytes: new Uint8Array([1]), mime: "image/png" }, otherId),
    ).toBeNull();
    expect(await removeBrandLogo(prisma, otherId)).toBeNull();
    expect((await readBrandSettings(prisma)).name).toBe("Acme Crew");
  });

  it("resolves the stored brand over the environment, and falls back when cleared", async () => {
    const reader = createBrandReader(prisma, { PUBLIC_BRAND_TAGLINE: "Env tagline." });
    expect(await reader.brand()).toEqual({
      name: "Acme Crew",
      shortName: "Crew",
      tagline: "Env tagline.",
    });
    await saveBrandText(prisma, { name: null, shortName: null }, ownerId);
    // Cached until invalidated (another process sees it after the TTL).
    expect((await reader.brand()).name).toBe("Acme Crew");
    reader.invalidate();
    expect(await reader.brand()).toEqual({ ...UPSTREAM_BRAND, tagline: "Env tagline." });
  });
});
