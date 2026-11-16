import * as Application from "expo-application";
import Constants from "expo-constants";
import { Platform } from "react-native";

/**
 * withJZ Crew ships without expo-updates: the binary is the only code that runs, so every
 * launch is the embedded bundle. Kept as a type so the account footer stays unchanged.
 */
export type AppUpdateIdentity = { kind: "embedded" };

export type AppVersionInfo = {
  /** Store / native binary version, e.g. `1.0.3 (10)`. */
  nativeLabel: string | null;
  update: AppUpdateIdentity;
};

type Translate = (message: string, values?: Record<string, string | number>) => string;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function fallbackNativeVersion(): { version: string | null; build: string | null } {
  const version = readString(Constants.expoConfig?.version);
  if (Platform.OS === "ios") {
    return { version, build: readString(Constants.platform?.ios?.buildNumber) };
  }
  if (Platform.OS === "android") {
    const code = Constants.platform?.android?.versionCode;
    return { version, build: code != null ? String(code) : null };
  }
  return { version, build: null };
}

/** Format store version + build as `1.0.3 (10)`, or either part alone. */
export function formatNativeVersionLabel(
  applicationVersion: string | null | undefined,
  buildVersion: string | null | undefined,
): string | null {
  const version = readString(applicationVersion);
  const build = readString(buildVersion);
  if (version && build) return `${version} (${build})`;
  return version ?? build;
}

/** Human update line for the account footer (English source strings for i18n). */
export function formatUpdateLabel(_update: AppUpdateIdentity, t: Translate): string {
  return t("Embedded");
}

/** Read the native store version for the account footer. */
export function getAppVersionInfo(): AppVersionInfo {
  let applicationVersion: string | null = null;
  let buildVersion: string | null = null;
  try {
    applicationVersion = readString(Application.nativeApplicationVersion);
    buildVersion = readString(Application.nativeBuildVersion);
  } catch {
    // Hosts without the native module still get the expo config fallback below.
  }
  const fallback = fallbackNativeVersion();
  return {
    nativeLabel: formatNativeVersionLabel(
      applicationVersion ?? fallback.version,
      buildVersion ?? fallback.build,
    ),
    update: { kind: "embedded" },
  };
}
