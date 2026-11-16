import { beforeEach, describe, expect, it, vi } from "vitest";

const notifications = vi.hoisted(() => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(),
  getDevicePushTokenAsync: vi.fn(),
}));
const api = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("expo-notifications", () => notifications);
vi.mock("./api", () => api);

import { PUSH_NOTIFICATIONS_AVAILABLE, registerPushToken, unregisterPushToken } from "./push";

describe("push without an EAS project", () => {
  beforeEach(() => {
    for (const fn of [...Object.values(notifications), api.rpc]) fn.mockReset();
    api.rpc.mockResolvedValue(undefined);
  });

  it("is reported as not set up", () => {
    expect(PUSH_NOTIFICATIONS_AVAILABLE).toBe(false);
  });

  it("asks for the alert permission but never mints or registers a push token", async () => {
    notifications.getPermissionsAsync.mockResolvedValue({ granted: false });
    notifications.requestPermissionsAsync.mockResolvedValue({ granted: true });

    await registerPushToken();

    expect(notifications.requestPermissionsAsync).toHaveBeenCalledOnce();
    expect(notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(notifications.getDevicePushTokenAsync).not.toHaveBeenCalled();
    expect(api.rpc).not.toHaveBeenCalled();
  });

  it("does not ask again once granted", async () => {
    notifications.getPermissionsAsync.mockResolvedValue({ granted: true });
    await registerPushToken();
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it("never throws when the permission API fails", async () => {
    notifications.getPermissionsAsync.mockRejectedValue(new Error("no native module"));
    await expect(registerPushToken()).resolves.toBeUndefined();
  });

  it("still clears a token an older build registered", async () => {
    api.rpc.mockRejectedValue(new Error("offline"));
    await expect(unregisterPushToken()).resolves.toBeUndefined();
    expect(api.rpc).toHaveBeenCalledWith("notifications/unregisterPush");
  });
});
