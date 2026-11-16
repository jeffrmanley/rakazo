# withJZ Crew Android release

The Android app is `apps/mobile` built as **withJZ Crew** (`com.withjz.crew`). It talks only to
the server in `EXPO_PUBLIC_API_URL` (default `https://eu-2.tail290516.ts.net`, HTTPS required
for a release) and is distributed through Google Play **internal testing** only.

## What differs from upstream

- Name, package and bundle id (`com.withjz.crew`), Expo owner `withjz-llc`, slug `withjz-crew`.
  User-visible copy says withJZ Crew; `lib/brand.ts` also rebrands shared strings from
  `@rakazo/core` and `@rakazo/contracts` as they pass through `t()`. Internal identifiers keep the
  upstream name: the `rakazo://` scheme (the server trusts it as the native origin), the
  `rakazo-notifications` module, storage keys and headers.
- **No over-the-air updates.** `expo-updates` is removed, `updates.enabled` is `false`, and there
  is no `updates.url` or `extra.eas.projectId`. Upstream's app pointed both at upstream's EAS
  project, which would have let that project push JavaScript into this app. `app.config.ts`
  refuses a config that turns any of this back on, and `lib/release-config.test.ts` checks it.
- **No remote push (yet).** `lib/push.ts` never mints or registers an Expo push token
  (`PUSH_NOTIFICATIONS_AVAILABLE = false`); Settings → Account → Notifications says push is not
  set up. Upstream's tokens were tied to upstream's EAS project, so pushes would have gone
  through upstream's Expo and FCM credentials. The server's sender
  (`packages/adapters/src/expo-push.ts`) finds no token and sends nothing. Alerts still come from
  the app's own live connection (`modules/rakazo-notifications`): while the app is open, and in
  the background while an agent is working.
- The AI data sharing screen links only the deployment's own privacy policy
  (`PRIVACY_POLICY_URL`), never upstream's page.
- Two-factor sign-in (authenticator code, backup code, trusted device): see
  `docs/security/two-factor.md`.
- Icons come from logo A (`assets/brand/withjz-crew-a.svg`); regenerate them with
  `bash apps/mobile/scripts/generate-brand-icons.sh` (needs `rsvg-convert` and DejaVu Sans).

## Building

```sh
CREW_OUT=~/crew-builds/android bash apps/mobile/scripts/build-android-release.sh
```

It runs `expo prebuild` on the host, then Gradle inside a digest-pinned `eclipse-temurin:17`
container (rootless Docker), and writes `withjz-crew-<version>-<versionCode>.aab` and `.apk` plus
`SHA256SUMS`. No EAS build, no Expo account. The Gradle wrapper JAR and distribution are checked
against Gradle's published SHA-256 values.

One-time setup, all outside the repo:

1. Android SDK in `~/crew-build-cache/android-sdk`: download Google's command-line tools, check
   the zip against the SHA-256 on <https://developer.android.com/studio>, then
   `sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "ndk;27.1.12297006" "cmake;3.22.1"`
   inside the same container.
2. Upload key in `~/.config/crew-android/` (directory 700, files 600): `upload-keystore.jks`
   (RSA 4096, alias `upload`), its password in `upload-keystore.pass`, and the public
   `upload-cert.pem`. Gradle reads the key from `CREW_UPLOAD_STORE_FILE` and the password from
   the file named by `CREW_UPLOAD_STORE_PASSWORD_FILE` (`plugins/with-release-signing.js`);
   without them a release build fails instead of falling back to the public debug key.

Google Play App Signing holds the app signing key; this key only uploads. If it is lost, request
an upload key reset in Play Console with a new `upload-cert.pem`.

## Releasing a new version

Raise `expo.version` and `expo.android.versionCode` in `apps/mobile/app.json` (Play refuses a
`versionCode` it has seen), rebuild, and upload the `.aab` to the internal testing track.

## Turning on push later

1. Create an EAS project under the `withjz-llc` Expo account (`eas init`) and put its id in
   `expo.extra.eas.projectId`. Push needs only the project id, not EAS Update: keep
   `updates.enabled: false` and no `updates.url` (`app.config.ts` and
   `lib/release-config.test.ts` must then allow the project id but still refuse the update URL).
2. In Firebase, create an Android app for `com.withjz.crew`, add its `google-services.json` as
   `expo.android.googleServicesFile`, and upload the FCM V1 service-account key to the Expo project
   (`eas credentials`, Android, Push Notifications).
3. Set `PUSH_NOTIFICATIONS_AVAILABLE = true` and restore token minting in `lib/push.ts`
   (`getExpoPushTokenAsync({ projectId })`, then `notifications/registerPush`).
4. Optionally add an Expo access token to the server's push request ("enhanced push security").

Pushes then go app → server → Expo → FCM → device, so Expo and Google see each notification's
title and body. Today those carry content: the server sends the bot name in the title and a
preview of the reply, the failure text, the bot's question or the screen reason in the body
(`packages/adapters/src/executor.ts`, `notifyRun`). The app's own live notifications also show the
reply text and the prompt. Make both content-free (for example "New message from <bot>") before
turning push on.
