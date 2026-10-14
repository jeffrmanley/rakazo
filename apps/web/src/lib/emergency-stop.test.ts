import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlState, ControlStop } from "./emergency-stop";
import {
  botPausedBy,
  botStopOf,
  fetchControlState,
  sendControl,
  spaceStopOf,
} from "./emergency-stop";

const stop = (overrides: Partial<ControlStop>): ControlStop => ({
  id: "s",
  scope: "bot",
  botId: "bot-1",
  reason: "r",
  stoppedAt: "2026-10-15T10:00:00.000Z",
  stoppedBy: { id: "u", name: "Dana" },
  ...overrides,
});
const state = (stops: ControlStop[]): ControlState => ({
  canControl: true,
  canControlGlobal: false,
  stops,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stop state helpers", () => {
  it("knows which bots are paused and why", () => {
    const current = state([stop({ id: "b", botId: "bot-1" })]);
    expect(botPausedBy(current, "bot-1")?.id).toBe("b");
    expect(botPausedBy(current, "bot-2")).toBeNull();
    expect(botStopOf(current, "bot-1")?.id).toBe("b");
    expect(spaceStopOf(current)).toBeNull();
  });

  it("pauses every bot under a space or global stop, but only a bot stop is resumable per bot", () => {
    const current = state([stop({ id: "sp", scope: "space", botId: null })]);
    expect(botPausedBy(current, "bot-9")?.id).toBe("sp");
    expect(botStopOf(current, "bot-9")).toBeNull();
    expect(spaceStopOf(current)?.id).toBe("sp");
    const global = state([stop({ id: "g", scope: "global", botId: null })]);
    expect(botPausedBy(global, "bot-9")?.id).toBe("g");
    expect(spaceStopOf(global)).toBeNull();
    expect(botPausedBy(null, "bot-1")).toBeNull();
  });
});

describe("control requests", () => {
  it("reads the state of the selected space, and treats 404 as the module being off", async () => {
    const fetchMock = vi.fn(async () => Response.json(state([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchControlState("space-a")).resolves.toEqual(state([]));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/control/state");
    expect(new Headers(init.headers).get("x-rakazo-space-id")).toBe("space-a");
    expect(init.credentials).toBe("include");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    await expect(fetchControlState("space-a")).resolves.toBeNull();
  });

  it("posts stop and resume without a space id in the body", async () => {
    const fetchMock = vi.fn(async () => Response.json({ resumed: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    await sendControl("resume", { scope: "bot", botId: "bot-1" }, "space-a");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/control/resume");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toEqual({ scope: "bot", botId: "bot-1", reason: "Resumed from the app" });
    expect(body).not.toHaveProperty("spaceId");
  });

  it("throws when the server refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Forbidden" }, { status: 403 })),
    );
    await expect(sendControl("stop", { scope: "space" }, "space-a")).rejects.toThrow("Forbidden");
  });
});
