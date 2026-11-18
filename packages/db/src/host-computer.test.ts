import { describe, expect, it } from "vitest";
import { hostComputerAllowed, sandboxKindFor } from "./host-computer.js";

describe("host computer gate", () => {
  it("is off unless ALLOW_HOST_COMPUTER=1", () => {
    expect(hostComputerAllowed({})).toBe(false);
    expect(hostComputerAllowed({ ALLOW_HOST_COMPUTER: "" })).toBe(false);
    expect(hostComputerAllowed({ ALLOW_HOST_COMPUTER: "true" })).toBe(false);
    expect(hostComputerAllowed({ ALLOW_HOST_COMPUTER: "0" })).toBe(false);
    expect(hostComputerAllowed({ ALLOW_HOST_COMPUTER: "1" })).toBe(true);
  });

  it("runs bots on the host only for docker deployments that allow it and chose it", () => {
    expect(sandboxKindFor("docker", "this-mac", true)).toBe("desktop");
    expect(sandboxKindFor("docker", "this-mac", false)).toBe("docker");
    expect(sandboxKindFor("docker", "docker", true)).toBe("docker");
    expect(sandboxKindFor("docker", null, true)).toBe("docker");
    expect(sandboxKindFor("e2b", "this-mac", true)).toBe("e2b");
    expect(sandboxKindFor("fake", "this-mac", true)).toBe("fake");
  });
});
