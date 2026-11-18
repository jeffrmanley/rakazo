import { describe, expect, it } from "vitest";
import {
  canChooseHostComputer,
  computerHostFor,
  hostComputerRefusal,
} from "./host-computer-choice.js";

describe("host computer choice", () => {
  it("offers the choice only to the owner of a docker deployment that allows the host", () => {
    expect(
      canChooseHostComputer({ isOwner: true, sandboxProvider: "docker", allowHost: true }),
    ).toBe(true);
    expect(
      canChooseHostComputer({ isOwner: true, sandboxProvider: "docker", allowHost: false }),
    ).toBe(false);
    expect(
      canChooseHostComputer({ isOwner: false, sandboxProvider: "docker", allowHost: true }),
    ).toBe(false);
    expect(canChooseHostComputer({ isOwner: true, sandboxProvider: "fake", allowHost: true })).toBe(
      false,
    );
  });

  it("reports a stored host choice as docker when the host is not allowed", () => {
    expect(computerHostFor("this-mac", "docker", false)).toBe("docker");
    expect(computerHostFor("this-mac", "docker", true)).toBe("this-mac");
    expect(computerHostFor("docker", "docker", false)).toBe("docker");
    expect(computerHostFor(null, "docker", false)).toBeNull();
    expect(computerHostFor("bogus", "docker", true)).toBeNull();
    expect(computerHostFor(null, "fake", true)).toBeNull();
    // An operator who runs the desktop provider has chosen the host explicitly.
    expect(computerHostFor(null, "desktop", false)).toBe("this-mac");
  });

  it("refuses to store the host choice unless docker and allowed", () => {
    expect(hostComputerRefusal("this-mac", "docker", true)).toBeNull();
    expect(hostComputerRefusal("this-mac", "docker", false)).toMatch(/turned off on this server/);
    expect(hostComputerRefusal("this-mac", "fake", true)).toMatch(
      /This Mac mode is only available/,
    );
    expect(hostComputerRefusal("docker", "docker", false)).toBeNull();
    expect(hostComputerRefusal(undefined, "docker", false)).toBeNull();
    expect(hostComputerRefusal(null, "docker", false)).toBeNull();
  });
});
