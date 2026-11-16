import * as Notifications from "expo-notifications";
import { rpc } from "./api";

/**
 * Remote push is not set up in this build. Upstream's push went through Expo's push service under
 * upstream's EAS project (and its FCM credentials); that project id was removed on purpose, and
 * withJZ Crew has no EAS project or FCM credentials of its own yet. So the app never mints or
 * registers a push token, and the server's push sender finds no token and sends nothing.
 *
 * Alerts still come from the app's own live connection to the server (`live-notifications`),
 * which needs only the notification permission. Turning push on later needs an EAS project under
 * the `withjz-llc` Expo account, its project id in app.json, google-services.json with that
 * project's FCM credentials uploaded to Expo, and this flag (docs/mobile-android-release.md).
 */
export const PUSH_NOTIFICATIONS_AVAILABLE = false;

/** Asks for the permission local alerts need. Never throws: the app works without push. */
export async function registerPushToken(): Promise<void> {
  try {
    const existing = await Notifications.getPermissionsAsync();
    if (!existing.granted) await Notifications.requestPermissionsAsync();
  } catch {
    // A denied or unavailable permission only means no alerts; nothing else depends on it.
  }
}

/** Clears any token an older build registered for this account on the server. */
export async function unregisterPushToken() {
  await rpc("notifications/unregisterPush").catch(() => undefined);
}
