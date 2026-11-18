/**
 * "This computer" mode runs bots directly on the machine that hosts the app, with no container
 * and no approval per command. It is off unless the operator sets ALLOW_HOST_COMPUTER=1, so a
 * server deployment (where "this computer" is the server itself) can never be switched to it
 * from the app. A choice stored before the gate existed is treated as Docker.
 */
export function hostComputerAllowed(env: Record<string, string | undefined> = process.env) {
  return env.ALLOW_HOST_COMPUTER === "1";
}

/** The sandbox a bot runs in: the host ("desktop") only when docker, allowed and chosen. */
export function sandboxKindFor(
  envKind: string,
  computerHost: string | null | undefined,
  allowHost: boolean = hostComputerAllowed(),
) {
  if (envKind === "docker" && computerHost === "this-mac" && allowHost) return "desktop";
  return envKind;
}
