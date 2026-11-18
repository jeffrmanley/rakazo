/** Pure rules for the "Where should bots run?" choice; the gate itself is hostComputerAllowed. */

export function canChooseHostComputer(input: {
  isOwner: boolean;
  sandboxProvider: string;
  allowHost: boolean;
}) {
  return input.isOwner && input.sandboxProvider === "docker" && input.allowHost;
}

export function computerHostFor(
  stored: string | null | undefined,
  sandboxProvider: string,
  allowHost: boolean,
): "docker" | "this-mac" | null {
  if (sandboxProvider === "desktop") return "this-mac";
  if (sandboxProvider !== "docker") return null;
  if (stored === "this-mac") return allowHost ? "this-mac" : "docker";
  if (stored === "docker") return stored;
  return null;
}

/** Why a requested computerHost must be refused, or null when it may be stored. */
export function hostComputerRefusal(
  requested: string | null | undefined,
  sandboxProvider: string,
  allowHost: boolean,
): string | null {
  if (requested !== "this-mac") return null;
  if (sandboxProvider !== "docker") {
    return "This Mac mode is only available when SANDBOX_PROVIDER=docker on a personal local app.";
  }
  if (!allowHost) return "Running bots on this computer is turned off on this server.";
  return null;
}
