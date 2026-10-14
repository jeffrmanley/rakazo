import { ORPCError } from "@orpc/client";

/**
 * The server's own explanation for a rejected request, or the fallback.
 * Only BAD_REQUEST carries text written for the user ("unlink it first");
 * every other code keeps the generic copy so internals never reach the UI.
 */
export function rpcErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ORPCError && error.code === "BAD_REQUEST") {
    const message = error.message.trim();
    if (message) return message;
  }
  return fallback;
}
