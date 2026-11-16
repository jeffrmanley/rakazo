import { afterEach, describe, expect, it, vi } from "vitest";

const application = vi.hoisted(() => ({
  nativeApplicationVersion: null as string | null,
  nativeBuildVersion: null as string | null,
}));

const constants = vi.hoisted(() => ({
  expoConfig: { version: "1.0.3" } as { version?: string } | null,
  platform: {
    ios: { buildNumber: "1" },
    android: { versionCode: 10 },
  } as {
    ios?: { buildNumber: string | null };
    android?: { versionCode: number };
  },
}));

vi.mock("expo-application", () => application);
vi.mock("expo-constants", () => ({ default: constants }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

afterEach(() => {
  application.nativeApplicationVersion = null;
  application.nativeBuildVersion = null;
  constants.expoConfig = { version: "1.0.3" };
  constants.platform = {
    ios: { buildNumber: "1" },
    android: { versionCode: 10 },
  };
  vi.resetModules();
});

describe("app version footer helpers", () => {
  it("formats native version with and without build", async () => {
    const { formatNativeVersionLabel } = await import("./app-version");
    expect(formatNativeVersionLabel("1.0.3", "10")).toBe("1.0.3 (10)");
    expect(formatNativeVersionLabel("1.0.3", null)).toBe("1.0.3");
    expect(formatNativeVersionLabel(null, "10")).toBe("10");
    expect(formatNativeVersionLabel("  ", "  ")).toBeNull();
  });

  it("prefers expo-application values and labels embedded updates", async () => {
    application.nativeApplicationVersion = "1.0.3";
    application.nativeBuildVersion = "12";
    const { formatUpdateLabel, getAppVersionInfo } = await import("./app-version");
    const info = getAppVersionInfo();
    expect(info.nativeLabel).toBe("1.0.3 (12)");
    expect(info.update).toEqual({ kind: "embedded" });
    expect(formatUpdateLabel(info.update, (message) => message)).toBe("Embedded");
  });

  it("falls back to Constants when Application is empty", async () => {
    const { getAppVersionInfo } = await import("./app-version");
    expect(getAppVersionInfo().nativeLabel).toBe("1.0.3 (1)");
  });

  it("always reports the embedded bundle: the app ships without expo-updates", async () => {
    const { getAppVersionInfo } = await import("./app-version");
    expect(getAppVersionInfo().update).toEqual({ kind: "embedded" });
  });
});
