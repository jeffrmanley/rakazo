import { describe, expect, it } from "vitest";
import { messageProviderLabel, providerLabel } from "./messaging";

describe("messaging provider labels", () => {
  it("names every mounted platform", () => {
    expect(providerLabel("slack")).toBe("Slack");
    expect(providerLabel("lark")).toBe("Feishu");
    expect(providerLabel("teams")).toBe("Microsoft Teams");
    expect(messageProviderLabel("teams")).toBe("Microsoft Teams");
  });

  it("falls back to the raw provider id", () => {
    expect(providerLabel("unknown-provider")).toBe("unknown-provider");
  });
});
