import { describe, expect, it } from "vitest";
import {
  brandManifest,
  brandMonogramSvg,
  escapeBrandMarkdown,
  isWhiteLabelled,
  resolveBrand,
  UPSTREAM_BRAND,
  UPSTREAM_ICONS,
  validateBrandText,
} from "./brand.js";

describe("resolveBrand", () => {
  it("defaults to the upstream product when nothing is configured", () => {
    expect(resolveBrand()).toEqual(UPSTREAM_BRAND);
    expect(resolveBrand({ PUBLIC_BRAND_NAME: "  ", PUBLIC_BRAND_TAGLINE: "" })).toEqual(
      UPSTREAM_BRAND,
    );
    expect(isWhiteLabelled(resolveBrand())).toBe(false);
  });

  it("follows PUBLIC_BRAND_NAME and derives the short name from it", () => {
    const brand = resolveBrand({ PUBLIC_BRAND_NAME: " withJZ Crew " });
    expect(brand).toEqual({
      name: "withJZ Crew",
      shortName: "withJZ Crew",
      tagline: UPSTREAM_BRAND.tagline,
    });
    expect(isWhiteLabelled(brand)).toBe(true);
  });

  it("takes an explicit short name and tagline", () => {
    expect(
      resolveBrand({
        PUBLIC_BRAND_NAME: "withJZ Crew",
        PUBLIC_BRAND_SHORT_NAME: "Crew",
        PUBLIC_BRAND_TAGLINE: "Agents for the crew.",
      }),
    ).toEqual({ name: "withJZ Crew", shortName: "Crew", tagline: "Agents for the crew." });
  });
});

describe("resolveBrand with runtime overrides", () => {
  const env = {
    PUBLIC_BRAND_NAME: "Env Name",
    PUBLIC_BRAND_SHORT_NAME: "Env",
    PUBLIC_BRAND_TAGLINE: "Env tagline.",
  };

  it("takes each field from the database first, then the environment, then upstream", () => {
    expect(resolveBrand(env, { name: "Db Name", shortName: "Db", tagline: "Db tagline." })).toEqual(
      { name: "Db Name", shortName: "Db", tagline: "Db tagline." },
    );
    expect(resolveBrand(env, { name: "Db Name", shortName: null, tagline: null })).toEqual({
      name: "Db Name",
      shortName: "Env",
      tagline: "Env tagline.",
    });
    expect(resolveBrand({}, { tagline: "Db tagline." })).toEqual({
      ...UPSTREAM_BRAND,
      tagline: "Db tagline.",
    });
  });

  it("derives the short name from the resolved name when no short name is set anywhere", () => {
    expect(resolveBrand({ PUBLIC_BRAND_NAME: "Env Name" }, { name: "Db Name" }).shortName).toBe(
      "Db Name",
    );
  });

  it("treats blank overrides as unset", () => {
    expect(resolveBrand(env, { name: "   ", shortName: "", tagline: null })).toEqual({
      name: "Env Name",
      shortName: "Env",
      tagline: "Env tagline.",
    });
    expect(resolveBrand({}, {})).toEqual(UPSTREAM_BRAND);
  });
});

describe("validateBrandText", () => {
  it("trims, and clears a field that is empty", () => {
    expect(validateBrandText({ name: "  Acme  ", shortName: "", tagline: "   " })).toEqual({
      ok: true,
      value: { name: "Acme", shortName: null, tagline: null },
    });
  });

  it("keeps fields that were not sent out of the update", () => {
    expect(validateBrandText({ tagline: "Hi." })).toEqual({ ok: true, value: { tagline: "Hi." } });
    expect(validateBrandText({ name: null })).toEqual({ ok: true, value: { name: null } });
  });

  it("limits the name and short name to 60 characters", () => {
    expect(validateBrandText({ name: "a".repeat(60) }).ok).toBe(true);
    expect(validateBrandText({ name: "a".repeat(61) })).toEqual({
      ok: false,
      field: "name",
      reason: "too_long",
    });
    expect(validateBrandText({ shortName: "b".repeat(61) })).toEqual({
      ok: false,
      field: "shortName",
      reason: "too_long",
    });
    // Counted in characters, not UTF-16 code units.
    expect(validateBrandText({ name: "😀".repeat(60) }).ok).toBe(true);
  });

  it("rejects invisible format characters and line or paragraph separators", () => {
    for (const bad of [
      "Acme\u202eemcA", // right-to-left override
      "Ac\u200bme", // zero-width space
      "Ac\u200dme", // zero-width joiner
      "Ac\u2066me", // left-to-right isolate
      "Ac\ufeffme", // byte order mark
      "Ac\u2028me", // line separator
      "Ac\u2029me", // paragraph separator
    ]) {
      for (const field of ["name", "shortName", "tagline"] as const) {
        expect(validateBrandText({ [field]: bad }), JSON.stringify(bad)).toEqual({
          ok: false,
          field,
          reason: "control_characters",
        });
      }
    }
    expect(validateBrandText({ name: "Café Crew 🚀" }).ok).toBe(true);
  });

  it("limits the tagline to 140 characters", () => {
    expect(validateBrandText({ tagline: "t".repeat(140) }).ok).toBe(true);
    expect(validateBrandText({ tagline: "t".repeat(141) })).toEqual({
      ok: false,
      field: "tagline",
      reason: "too_long",
    });
  });

  it("rejects control characters in every field", () => {
    for (const bad of ["Ac\u0000me", "Ac\nme", "Ac\tme", "Ac\u007fme", "Ac\u009bme"]) {
      expect(validateBrandText({ name: bad })).toEqual({
        ok: false,
        field: "name",
        reason: "control_characters",
      });
      expect(validateBrandText({ shortName: bad })).toMatchObject({
        ok: false,
        field: "shortName",
      });
      expect(validateBrandText({ tagline: bad })).toMatchObject({ ok: false, field: "tagline" });
    }
  });
});

describe("brandManifest", () => {
  it("describes the brand with the given icons", () => {
    const manifest = brandManifest({ name: "Acme Crew", shortName: "Crew", tagline: "Agents." }, [
      { src: "/api/v1/brand/logo?v=1", sizes: "any", type: "image/svg+xml" },
    ]);
    expect(manifest).toMatchObject({
      name: "Acme Crew",
      short_name: "Crew",
      description: "Agents.",
      start_url: "/",
      display: "standalone",
      icons: [{ src: "/api/v1/brand/logo?v=1", sizes: "any", type: "image/svg+xml" }],
    });
  });

  it("uses the upstream icons by default", () => {
    expect(brandManifest(UPSTREAM_BRAND).icons).toEqual(UPSTREAM_ICONS);
  });
});

describe("brandMonogramSvg", () => {
  it("draws the first letter of the name", () => {
    const svg = brandMonogramSvg("acme crew");
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain(">A</text>");
  });

  it("escapes markup and quotes from the name", () => {
    for (const name of ["<script>alert(1)</script>", '"onload="x', "'x", "&amp"]) {
      const svg = brandMonogramSvg(name);
      expect(svg).not.toContain("<script");
      expect(svg).not.toMatch(/>["'&<]<\/text>/);
    }
    expect(brandMonogramSvg("<b>")).toContain(">&lt;</text>");
    expect(brandMonogramSvg('"q')).toContain(">&quot;</text>");
    expect(brandMonogramSvg("'q")).toContain(">&#39;</text>");
    expect(brandMonogramSvg("&q")).toContain(">&amp;</text>");
  });

  it("keeps a whole emoji or accented letter and falls back for an empty name", () => {
    expect(brandMonogramSvg("😀 Crew")).toContain(">😀</text>");
    expect(brandMonogramSvg("élan")).toContain(">É</text>");
    expect(brandMonogramSvg("   ")).toContain("></text>");
  });
});

describe("escapeBrandMarkdown", () => {
  it("leaves plain names alone", () => {
    expect(escapeBrandMarkdown("Acme Crew 2")).toBe("Acme Crew 2");
  });

  it("escapes Markdown, link and mention syntax so chat apps show the name literally", () => {
    expect(escapeBrandMarkdown("*Acme* _Crew_ ~x~ `y`")).toBe(
      "\\*Acme\\* \\_Crew\\_ \\~x\\~ \\`y\\`",
    );
    expect(escapeBrandMarkdown("[Click](https://evil.example)")).toBe(
      "\\[Click\\]\\(https://evil.example\\)",
    );
    expect(escapeBrandMarkdown("<@U123> <!here> @here & \\")).toBe(
      "\\<\\@U123\\> \\<\\!here\\> \\@here \\& \\\\",
    );
  });
});
