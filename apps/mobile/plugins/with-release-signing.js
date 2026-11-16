const { withAppBuildGradle } = require("expo/config-plugins");

const MARKER = "crewUpload";

const SIGNING_CONFIG = `
        // withJZ Crew upload key (plugins/with-release-signing.js). Only paths come from the
        // environment; the password is read from a file outside the repo at build time.
        crewUpload {
            def crewStorePath = System.getenv("CREW_UPLOAD_STORE_FILE")
            def crewPassPath = System.getenv("CREW_UPLOAD_STORE_PASSWORD_FILE")
            if (crewStorePath && crewPassPath) {
                def crewSecret = new File(crewPassPath).text.trim()
                storeFile new File(crewStorePath)
                storePassword crewSecret
                keyAlias System.getenv("CREW_UPLOAD_KEY_ALIAS") ?: "upload"
                keyPassword crewSecret
            }
        }`;

const DEBUG_RELEASE = `            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug`;

/**
 * Release builds sign with the upload key named by CREW_UPLOAD_STORE_FILE and
 * CREW_UPLOAD_STORE_PASSWORD_FILE, never with the template's public debug key. Without them,
 * Gradle stops at validateSigningRelease instead of producing a debug-signed release.
 */
function applyReleaseSigning(contents) {
  if (contents.includes(MARKER)) return contents;
  if (!contents.includes("    signingConfigs {\n") || !contents.includes(DEBUG_RELEASE)) {
    throw new Error(
      "with-release-signing: the Expo build.gradle template changed; update the plugin",
    );
  }
  return contents
    .replace("    signingConfigs {\n", `    signingConfigs {${SIGNING_CONFIG}\n`)
    .replace(
      DEBUG_RELEASE,
      `            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.crewUpload`,
    );
}

function withReleaseSigning(config) {
  return withAppBuildGradle(config, (config) => {
    config.modResults.contents = applyReleaseSigning(config.modResults.contents);
    return config;
  });
}

module.exports = withReleaseSigning;
module.exports.applyReleaseSigning = applyReleaseSigning;
