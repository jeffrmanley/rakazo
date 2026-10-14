import { useCallback, useEffect, useState } from "react";
import { withSpaceHeaders } from "./rpc";

/**
 * Fork extension: emergency stop (EXT_EMERGENCY_STOP). The server owns
 * authorization and the space comes from the session; this only reads the
 * state of the selected space and asks for a stop or resume.
 */

export type ControlScope = "bot" | "space" | "global";

export interface ControlStop {
  id: string;
  scope: ControlScope;
  botId: string | null;
  reason: string;
  stoppedAt: string;
  stoppedBy: { id: string; name: string };
}

export interface ControlState {
  canControl: boolean;
  canControlGlobal: boolean;
  stops: ControlStop[];
}

const STATE_PATH = "/api/v1/control/state";
const POLL_MS = 15_000;

/** The stop that pauses this bot (bot, space or global), if any. */
export function botPausedBy(state: ControlState | null, botId: string): ControlStop | null {
  return state?.stops.find((stop) => stop.scope !== "bot" || stop.botId === botId) ?? null;
}

/** A stop of this bot alone, which its own Resume lifts. */
export function botStopOf(state: ControlState | null, botId: string): ControlStop | null {
  return state?.stops.find((stop) => stop.scope === "bot" && stop.botId === botId) ?? null;
}

export function spaceStopOf(state: ControlState | null): ControlStop | null {
  return state?.stops.find((stop) => stop.scope === "space") ?? null;
}

/** Null when the deployment has the emergency stop turned off (the routes are absent). */
export async function fetchControlState(
  spaceId: string | null,
  signal?: AbortSignal,
): Promise<ControlState | null> {
  const res = await fetch(STATE_PATH, {
    headers: withSpaceHeaders(undefined, spaceId),
    credentials: "include",
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`control state ${res.status}`);
  return (await res.json()) as ControlState;
}

export async function sendControl(
  action: "stop" | "resume",
  target: { scope: "bot"; botId: string } | { scope: "space" },
  spaceId: string | null,
): Promise<void> {
  const res = await fetch(`/api/v1/control/${action}`, {
    method: "POST",
    headers: withSpaceHeaders({ "content-type": "application/json" }, spaceId),
    credentials: "include",
    body: JSON.stringify({
      ...target,
      reason: action === "stop" ? "Stopped from the app" : "Resumed from the app",
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `control ${action} ${res.status}`);
  }
}

/** Stop state of the session space, polled while the module is on. */
export function useControlState(spaceId: string | null | undefined) {
  const [state, setState] = useState<ControlState | null>(null);
  const [enabled, setEnabled] = useState(true);

  const refresh = useCallback(async () => {
    if (!spaceId) return;
    try {
      const next = await fetchControlState(spaceId);
      if (!next) setEnabled(false);
      setState(next);
    } catch {
      // Keep the last known state; the next poll retries.
    }
  }, [spaceId]);

  useEffect(() => {
    setState(null);
    setEnabled(true);
  }, [spaceId]);

  useEffect(() => {
    if (!spaceId || !enabled) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [spaceId, enabled, refresh]);

  const control = useCallback(
    async (
      action: "stop" | "resume",
      target: { scope: "bot"; botId: string } | { scope: "space" },
    ) => {
      try {
        await sendControl(action, target, spaceId ?? null);
      } finally {
        await refresh();
      }
    },
    [spaceId, refresh],
  );

  return { state, control };
}
