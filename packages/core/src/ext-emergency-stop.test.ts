import { describe, expect, it } from "vitest";
import { formatPausedReply, parseControlCommand } from "./ext-emergency-stop.js";

describe("parseControlCommand", () => {
  it("reads /stop and /resume for the whole space", () => {
    expect(parseControlCommand("/stop")).toEqual({ action: "stop", botName: null });
    expect(parseControlCommand("  /resume  ")).toEqual({ action: "resume", botName: null });
    expect(parseControlCommand("/STOP")).toEqual({ action: "stop", botName: null });
  });

  it("reads a bot name, with or without quotes or an @", () => {
    expect(parseControlCommand("/stop Alice")).toEqual({ action: "stop", botName: "Alice" });
    expect(parseControlCommand("/resume  Sales Bot ")).toEqual({
      action: "resume",
      botName: "Sales Bot",
    });
    expect(parseControlCommand('/stop "Sales Bot"')).toEqual({
      action: "stop",
      botName: "Sales Bot",
    });
    expect(parseControlCommand("/stop @alice")).toEqual({ action: "stop", botName: "alice" });
  });

  it("skips leading mentions of the bot account (Slack and Teams)", () => {
    expect(parseControlCommand("<@U123ABC> /stop Alice")).toEqual({
      action: "stop",
      botName: "Alice",
    });
    expect(parseControlCommand("<at>Crew</at> /resume")).toEqual({
      action: "resume",
      botName: null,
    });
    expect(parseControlCommand("@crew /stop")).toEqual({ action: "stop", botName: null });
  });

  it("treats anything else as ordinary text", () => {
    expect(parseControlCommand("please stop")).toBeNull();
    expect(parseControlCommand("/stopwatch")).toBeNull();
    expect(parseControlCommand("/stop\nand then do something")).toBeNull();
    expect(parseControlCommand("text /stop")).toBeNull();
    expect(parseControlCommand("")).toBeNull();
    expect(parseControlCommand(`/stop ${"x".repeat(200)}`)).toBeNull();
  });
});

describe("formatPausedReply", () => {
  it("names who paused the bot and when, in UTC", () => {
    expect(
      formatPausedReply({ name: "Dana Owner", at: new Date("2026-10-15T09:05:42.123Z") }),
    ).toBe("Paused by Dana Owner at 2026-10-15 09:05 UTC");
  });

  it("falls back to a neutral actor when the name is blank", () => {
    expect(formatPausedReply({ name: "  ", at: new Date("2026-01-02T03:04:05Z") })).toBe(
      "Paused by an owner at 2026-01-02 03:04 UTC",
    );
  });
});
