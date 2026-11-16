import type { ConfigContext, ExpoConfig } from "expo/config";

const RELEASE_PROFILES = new Set(["production", "android-apk"]);

/**
 * withJZ Crew ships without over-the-air updates: the binary is the only code that runs, so no
 * update server (upstream's EAS project, or any other) can change it after install. Refuse any
 * config that would turn them back on or point the app at an EAS project.
 */
export function assertNoRemoteUpdates(config: Partial<ExpoConfig>): void {
  const updates = config.updates;
  if (updates?.url) throw new Error("app.json must not set updates.url: OTA updates are disabled.");
  if (updates?.enabled !== false)
    throw new Error("app.json must set updates.enabled to false: OTA updates are disabled.");
  const eas = (config.extra as { eas?: { projectId?: unknown } } | undefined)?.eas;
  if (eas?.projectId)
    throw new Error("app.json must not set extra.eas.projectId: this build has no EAS project.");
  if (config.runtimeVersion !== undefined)
    throw new Error("app.json must not set runtimeVersion: it only matters for OTA updates.");
}

/** A local release build (`CREW_RELEASE_BUILD=1`) or an EAS release profile. */
function isReleaseBuild(): boolean {
  return (
    process.env.CREW_RELEASE_BUILD === "1" ||
    RELEASE_PROFILES.has(process.env.EAS_BUILD_PROFILE ?? "")
  );
}

export function assertReleaseApiUrl(apiUrl: string | undefined): void {
  if (!apiUrl) {
    throw new Error("EXPO_PUBLIC_API_URL must be set before building a release.");
  }
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error("EXPO_PUBLIC_API_URL must be a valid URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("EXPO_PUBLIC_API_URL must use HTTPS for production builds.");
  }
}

export default ({ config }: ConfigContext): ExpoConfig => {
  assertNoRemoteUpdates(config);
  if (isReleaseBuild()) assertReleaseApiUrl(process.env.EXPO_PUBLIC_API_URL);
  return config as ExpoConfig;
};
