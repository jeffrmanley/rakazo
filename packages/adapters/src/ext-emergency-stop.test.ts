import type { ActiveStop, EmergencyStopReader } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRunStopGuard,
  EmergencyStopError,
  guardTeamChatSend,
  SUPPRESSED_SEND_HANDLE,
} from "./ext-emergency-stop.js";

const target = { spaceId: "space-a", botId: "bot-1" };
const active: ActiveStop = {
  id: "stop-1",
  scope: "bot",
  spaceId: "space-a",
  botId: "bot-1",
  reason: "runaway",
  stoppedBy: "user-1",
  stoppedAt: new Date("2026-10-15T10:00:00Z"),
};

function fakeReader(initial: ActiveStop | null = null) {
  let current = initial;
  const reader: EmergencyStopReader = {
    check: vi.fn(async () => current),
    activeStops: vi.fn(async () => (current ? [current] : [])),
    invalidate: vi.fn(),
  };
  return {
    reader,
    set(value: ActiveStop | null) {
      current = value;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createRunStopGuard", () => {
  it("is a no-op when the module is off", async () => {
    const onStop = vi.fn();
    const guard = createRunStopGuard({ reader: null, target, onStop });
    const execute = vi.fn(async () => "ok");
    expect(await guard.check()).toBeNull();
    expect(guard.wrapTool(execute)).toBe(execute);
    guard.dispose();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("reports a stop before the model is called and fires once", async () => {
    const { reader } = fakeReader(active);
    const onStop = vi.fn();
    const guard = createRunStopGuard({ reader, target, onStop });
    expect(await guard.check()).toBe(active);
    expect(await guard.check()).toBe(active);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledWith(active);
    expect(guard.stopped).toBe(active);
    guard.dispose();
  });

  it("drops a queued tool call once stopped", async () => {
    const { reader } = fakeReader(active);
    const onStop = vi.fn();
    const guard = createRunStopGuard({ reader, target, onStop });
    const execute = vi.fn(async () => "ran");
    const wrapped = guard.wrapTool(execute);
    await expect(wrapped("shell", {}, "exec-1")).rejects.toBeInstanceOf(EmergencyStopError);
    expect(execute).not.toHaveBeenCalled();
    expect(onStop).toHaveBeenCalledTimes(1);
    guard.dispose();
  });

  it("lets a tool call already in flight finish, then halts the run", async () => {
    vi.useFakeTimers();
    const { reader, set } = fakeReader(null);
    const onStop = vi.fn();
    const guard = createRunStopGuard({ reader, target, onStop, intervalMs: 1_000 });
    const gate = deferred<string>();
    const execute = vi.fn(() => gate.promise);
    const call = guard.wrapTool(execute)("shell", { command: "sleep 2" }, "exec-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(1);

    set(active);
    await vi.advanceTimersByTimeAsync(1_000);
    // The watcher saw the stop, but the call is mid-flight: no abort yet.
    expect(guard.stopped).toBe(active);
    expect(onStop).not.toHaveBeenCalled();

    gate.resolve("finished");
    // The outcome still reaches the caller (and the audit wrapper inside it).
    await expect(call).resolves.toBe("finished");
    expect(onStop).toHaveBeenCalledTimes(1);

    // Nothing new runs afterwards.
    const next = vi.fn(async () => "never");
    await expect(guard.wrapTool(next)("shell", {}, "exec-2")).rejects.toBeInstanceOf(
      EmergencyStopError,
    );
    expect(next).not.toHaveBeenCalled();
    guard.dispose();
  });

  it("does not halt the run when the stop is lifted before the in-flight tool call ends", async () => {
    vi.useFakeTimers();
    const { reader, set } = fakeReader(null);
    const onStop = vi.fn();
    const guard = createRunStopGuard({ reader, target, onStop, intervalMs: 1_000 });
    const gate = deferred<string>();
    const call = guard.wrapTool(() => gate.promise)("shell", {}, "exec-1");
    await vi.advanceTimersByTimeAsync(0);
    set(active);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(guard.stopped).toBe(active);
    // Resumed while the call was still running.
    set(null);
    gate.resolve("finished");
    await expect(call).resolves.toBe("finished");
    expect(onStop).not.toHaveBeenCalled();
    expect(guard.stopped).toBeNull();
    const next = vi.fn(async () => "ran");
    await expect(guard.wrapTool(next)("shell", {}, "exec-2")).resolves.toBe("ran");
    guard.dispose();
  });

  it("checks again after each tool, before the next model call", async () => {
    const { reader, set } = fakeReader(null);
    const onStop = vi.fn();
    const guard = createRunStopGuard({ reader, target, onStop, intervalMs: 60_000 });
    const wrapped = guard.wrapTool(async () => {
      set(active);
      return "done";
    });
    await expect(wrapped("shell", {}, "exec-1")).resolves.toBe("done");
    expect(onStop).toHaveBeenCalledWith(active);
    guard.dispose();
  });

  it("aborts an in-flight model call from the watcher within one interval", async () => {
    vi.useFakeTimers();
    const { reader, set } = fakeReader(null);
    const onStop = vi.fn();
    const guard = createRunStopGuard({ reader, target, onStop, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onStop).not.toHaveBeenCalled();
    set(active);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onStop).toHaveBeenCalledTimes(1);
    guard.dispose();
    expect(reader.check).toHaveBeenCalledWith(target);
  });

  it("stops watching once disposed", async () => {
    vi.useFakeTimers();
    const { reader, set } = fakeReader(null);
    const onStop = vi.fn();
    const guard = createRunStopGuard({ reader, target, onStop, intervalMs: 1_000 });
    guard.dispose();
    set(active);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("keeps watching after a failed read", async () => {
    vi.useFakeTimers();
    const { reader, set } = fakeReader(null);
    (reader.check as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("blip"));
    const onStop = vi.fn();
    const guard = createRunStopGuard({ reader, target, onStop, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    set(active);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onStop).toHaveBeenCalledTimes(1);
    guard.dispose();
  });
});

describe("guardTeamChatSend", () => {
  const request = { conversationId: "c", replyThreadId: null, content: "hi" };

  it("passes sends through when the module is off or the bot runs", async () => {
    const send = vi.fn(async () => ({ handle: "h1" }));
    expect(guardTeamChatSend(send, { reader: null, bot: async () => target })).toBe(send);
    const { reader } = fakeReader(null);
    const guarded = guardTeamChatSend(send, { reader, bot: async () => target });
    await expect(guarded(request)).resolves.toEqual({ handle: "h1" });
  });

  it("suppresses a stopped bot's reply instead of posting it", async () => {
    const send = vi.fn(async () => ({ handle: "h1" }));
    const { reader } = fakeReader(active);
    const guarded = guardTeamChatSend(send, { reader, bot: async () => target });
    await expect(guarded(request)).resolves.toEqual({ handle: SUPPRESSED_SEND_HANDLE });
    expect(send).not.toHaveBeenCalled();
  });
});
