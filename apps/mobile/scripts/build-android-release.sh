#!/usr/bin/env bash
# Builds the signed withJZ Crew release (AAB for Google Play, APK fallback) locally in rootless
# Docker. No EAS, no Expo account. See docs/mobile-android-release.md.
#
# Needs, outside the repo:
#   $CREW_ANDROID_SDK          Android SDK (platform 36, build-tools 36.0.0, NDK 27.1.12297006,
#                              cmake 3.22.1), installed with Google's checksum-verified cmdline-tools
#   $CREW_GRADLE_HOME          Gradle cache directory
#   ~/.config/crew-android/upload-keystore.jks and upload-keystore.pass (mode 600)
# Optional: CREW_ABIS (default arm64-v8a,armeabi-v7a,x86_64), CREW_OUT (copy artifacts there).
set -euo pipefail

API_URL="${EXPO_PUBLIC_API_URL:-https://eu-2.tail290516.ts.net}"
CACHE="${CREW_BUILD_CACHE:-$HOME/crew-build-cache}"
SDK="${CREW_ANDROID_SDK:-$CACHE/android-sdk}"
GRADLE_HOME="${CREW_GRADLE_HOME:-$CACHE/gradle-home}"
KEYS="${CREW_KEYS_DIR:-$HOME/.config/crew-android}"
ABIS="${CREW_ABIS:-arm64-v8a,armeabi-v7a,x86_64}"
# eclipse-temurin:17-jdk-noble, pinned by digest (trivy: 0 HIGH/CRITICAL on 2026-11-16).
JDK_IMAGE="eclipse-temurin@sha256:1bedb04434bd275ef072355e9caec2a22be5240fbe82ad51a59323f2bbcab4a6"
# Gradle 9.3.1, from https://services.gradle.org/distributions/gradle-9.3.1-bin.zip.sha256
GRADLE_DIST_SHA256="b266d5ff6b90eada6dc3b20cb090e3731302e553a27c5d3e4df1f0d76beaff06"
GRADLE_WRAPPER_JAR_SHA256="b3a875ddc1f044746e1b1a55f645584505f4a10438c1afea9f15e92a7c42ec13"

MOBILE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$MOBILE/../.." && pwd)"
NODE_DIR="$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")"

for path in "$SDK" "$KEYS/upload-keystore.jks" "$KEYS/upload-keystore.pass"; do
  [[ -e "$path" ]] || { echo "missing: $path" >&2; exit 1; }
done
mkdir -p "$GRADLE_HOME"

cd "$MOBILE"
export CREW_RELEASE_BUILD=1 EXPO_PUBLIC_API_URL="$API_URL" EXPO_NO_TELEMETRY=1
npx expo prebuild --platform android --no-install --clean

WRAPPER="android/gradle/wrapper/gradle-wrapper.properties"
grep -q 'gradle-9.3.1-bin.zip' "$WRAPPER" || { echo "Gradle version changed; update the pinned checksums" >&2; exit 1; }
echo "$GRADLE_WRAPPER_JAR_SHA256  android/gradle/wrapper/gradle-wrapper.jar" | sha256sum -c -
echo "distributionSha256Sum=$GRADLE_DIST_SHA256" >>"$WRAPPER"
sed -i 's/^org.gradle.jvmargs=.*/org.gradle.jvmargs=-Xmx6g -XX:MaxMetaspaceSize=1g/' android/gradle.properties

# The repo is mounted at its own path so pnpm's symlinks resolve; node comes from the host.
# Only key paths reach the build as environment variables; the password stays in its file.
docker run --rm \
  -v "$REPO:$REPO" -w "$MOBILE/android" \
  -v "$NODE_DIR:/opt/node:ro" \
  -v "$SDK:/sdk" -v "$GRADLE_HOME:/gradle-home" \
  -v "$KEYS:/keys:ro" \
  -e PATH="/opt/node/bin:/opt/java/openjdk/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  -e ANDROID_HOME=/sdk -e ANDROID_SDK_ROOT=/sdk -e GRADLE_USER_HOME=/gradle-home \
  -e CREW_RELEASE_BUILD=1 -e EXPO_PUBLIC_API_URL="$API_URL" -e EXPO_NO_TELEMETRY=1 \
  -e NODE_ENV=production \
  -e CREW_UPLOAD_STORE_FILE=/keys/upload-keystore.jks \
  -e CREW_UPLOAD_STORE_PASSWORD_FILE=/keys/upload-keystore.pass \
  "$JDK_IMAGE" \
  ./gradlew --no-daemon -PreactNativeArchitectures="$ABIS" :app:bundleRelease :app:assembleRelease

AAB="$MOBILE/android/app/build/outputs/bundle/release/app-release.aab"
APK="$MOBILE/android/app/build/outputs/apk/release/app-release.apk"
ls -la "$AAB" "$APK"

if [[ -n "${CREW_OUT:-}" ]]; then
  VERSION="$(node -p 'require("./app.json").expo.version')"
  CODE="$(node -p 'require("./app.json").expo.android.versionCode')"
  mkdir -p "$CREW_OUT"
  cp "$AAB" "$CREW_OUT/withjz-crew-$VERSION-$CODE.aab"
  cp "$APK" "$CREW_OUT/withjz-crew-$VERSION-$CODE.apk"
  (cd "$CREW_OUT" && sha256sum withjz-crew-*.aab withjz-crew-*.apk >SHA256SUMS && cat SHA256SUMS)
fi
