import { describe, expect, it } from "vitest";
import { isWhiteLabelled, resolveBrand, UPSTREAM_BRAND } from "./brand.js";

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
