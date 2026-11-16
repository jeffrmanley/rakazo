import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertNoRemoteUpdates, assertReleaseApiUrl } from "../app.config";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

const mobileRoot = path.resolve(import.meta.dirname, "..");
const appJson = JSON.parse(readFileSync(path.join(mobileRoot, "app.json"), "utf8")) as {
  expo: Record<string, unknown> & {
    updates?: { url?: string; enabled?: boolean };
    extra?: { eas?: unknown };
    android: { package: string; versionCode: number };
    ios: { bundleIdentifier: string };
  };
};
const expo = appJson.expo;
const packageJson = JSON.parse(readFileSync(path.join(mobileRoot, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};

/** Source the app ships: everything Metro or Gradle can pull in, minus tests and docs. */
function shippedSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".") || name === "e2e") continue;
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (/\.(tsx?|jsx?|kt|java|xml|json)$/.test(name) && !/\.test\./.test(name))
        out.push(file);
    }
  };
  for (const dir of ["app", "components", "lib", "modules", "plugins"])
    walk(path.join(mobileRoot, dir));
  out.push(path.join(mobileRoot, "app.json"), path.join(mobileRoot, "app.config.ts"));
  return out;
}

describe("withJZ Crew release identity", () => {
  it("ships under its own name, package and version", () => {
    expect(expo.name).toBe("withJZ Crew");
    expect(expo.slug).toBe("withjz-crew");
    expect(expo.owner).toBe("withjz-llc");
    expect(expo.version).toBe("1.0.0");
    expect(expo.android.package).toBe("com.withjz.crew");
    expect(expo.android.versionCode).toBe(1);
    expect(expo.ios.bundleIdentifier).toBe("com.withjz.crew");
    // The server trusts this scheme as the native origin; it stays.
    expect(expo.scheme).toBe("rakazo");
  });
});

describe("no over-the-air updates", () => {
  it("has no update server, no EAS project and updates switched off", () => {
    expect(expo.updates).toEqual({ enabled: false, checkAutomatically: "NEVER" });
    expect(expo.extra?.eas).toBeUndefined();
    expect(expo.runtimeVersion).toBeUndefined();
    expect(() => assertNoRemoteUpdates(expo as never)).not.toThrow();
  });

  it("does not bundle expo-updates at all", () => {
    expect(packageJson.dependencies["expo-updates"]).toBeUndefined();
    for (const file of shippedSources()) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/["']expo-updates["']/);
    }
  });

  it("refuses a config that would turn updates back on", () => {
    const base = { updates: { enabled: false } };
    expect(() =>
      assertNoRemoteUpdates({ updates: { enabled: false, url: "https://u.expo.dev/x" } }),
    ).toThrow("updates.url");
    expect(() => assertNoRemoteUpdates({})).toThrow("updates.enabled");
    expect(() => assertNoRemoteUpdates({ updates: { enabled: true } })).toThrow("updates.enabled");
    expect(() =>
      assertNoRemoteUpdates({ ...base, extra: { eas: { projectId: "07f7eb04" } } }),
    ).toThrow("extra.eas.projectId");
    expect(() =>
      assertNoRemoteUpdates({ ...base, runtimeVersion: { policy: "appVersion" } }),
    ).toThrow("runtimeVersion");
  });

  it("requires an HTTPS server URL for a release build", () => {
    expect(() => assertReleaseApiUrl(undefined)).toThrow("must be set");
    expect(() => assertReleaseApiUrl("http://eu-2.tail290516.ts.net")).toThrow("HTTPS");
    expect(() => assertReleaseApiUrl("https://eu-2.tail290516.ts.net")).not.toThrow();
  });
});

describe("no upstream endpoints", () => {
  // Hosts that would reach upstream infrastructure or a third-party collector at runtime.
  const forbidden = [
    /u\.expo\.dev/,
    /exp\.host/,
    /expo\.(dev|io)\//,
    /07f7eb04-45e3-47fe-9374-99a2f991131e/,
    /getExpoPushTokenAsync/,
    /AI_PRIVACY_URL|rakazo\.com/,
    /sentry|bugsnag|posthog|amplitude|segment\.(io|com)|datadog|crashlytics/i,
  ];

  it("ships no update, push-relay or telemetry endpoint", () => {
    for (const file of shippedSources()) {
      const source = readFileSync(file, "utf8");
      for (const pattern of forbidden) expect(source, `${file} ${pattern}`).not.toMatch(pattern);
    }
  });
});

describe("user-visible name", () => {
  // Internal identifiers keep the upstream name; these are the only shipped mentions allowed.
  const allowed = [
    /RakazoNotifications?(Module|Service)?\b/g,
    /com\.rakazo\.notifications/g,
    // The shared contract string is the catalog key; t() rebrands it (see brand.ts).
    /Paste the OpenAI-compatible address from your server\. Rakazo adds \/v1 if needed\./g,
    /Prefer these over hardcoded Rakazo hexes/g,
    /const UPSTREAM_NAME = \/\\bRakazo\\b\/g/g,
  ];

  it("never says Rakazo in shipped copy", () => {
    const offenders: string[] = [];
    for (const file of shippedSources()) {
      let source = readFileSync(file, "utf8");
      for (const pattern of allowed) source = source.replace(pattern, "");
      for (const [index, line] of source.split("\n").entries())
        if (line.includes("Rakazo"))
          offenders.push(`${path.relative(mobileRoot, file)}:${index + 1}`);
    }
    expect(offenders).toEqual([]);
  });

  it("rebrands shared copy that names the upstream product", async () => {
    const { OPENAI_COMPATIBLE_BASE_URL_HINT } = await import("@rakazo/contracts");
    const { resetI18nForTests, t } = await import("./i18n");
    for (const locale of ["en", "de", "ru", "zh-CN"] as const) {
      resetI18nForTests(locale);
      const text = t(OPENAI_COMPATIBLE_BASE_URL_HINT);
      expect(text, locale).not.toContain("Rakazo");
      expect(text, locale).toContain("withJZ Crew");
    }
    resetI18nForTests("en");
  });
});

describe("brand assets", () => {
  it("draws the native notification glyph with the same path as the generated PNG", () => {
    const script = readFileSync(path.join(mobileRoot, "scripts/generate-brand-icons.sh"), "utf8");
    const drawable = readFileSync(
      path.join(
        mobileRoot,
        "modules/rakazo-notifications/android/src/main/res/drawable/ic_rakazo_notification.xml",
      ),
      "utf8",
    );
    const glyph = /NOTIFICATION_GLYPH="([^"]+)"/.exec(script)?.[1];
    expect(glyph).toBeTruthy();
    expect(drawable).toContain(`android:pathData="${glyph}"`);
  });
});
