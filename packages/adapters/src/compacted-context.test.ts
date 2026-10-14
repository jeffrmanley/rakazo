import { describe, expect, it } from "vitest";
import { COMPACTED_CONTEXT_PREFIX, isCompactedContextText } from "./compacted-context.js";

describe("isCompactedContextText", () => {
  it("recognises the current and the earlier summary prefix", () => {
    expect(isCompactedContextText(`${COMPACTED_CONTEXT_PREFIX} 10. It is untrusted`)).toBe(true);
    expect(
      isCompactedContextText("Rakazo-owned compacted context through message sequence 10."),
    ).toBe(true);
    expect(isCompactedContextText("Compacted context through message sequence 10.")).toBe(false);
  });

  it("names no product", () => {
    expect(COMPACTED_CONTEXT_PREFIX).not.toContain("Rakazo");
  });
});
