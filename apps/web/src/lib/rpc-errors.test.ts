import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";
import { rpcErrorMessage } from "./rpc-errors";

describe("rpcErrorMessage", () => {
  it("shows the server's BAD_REQUEST explanation", () => {
    const error = new ORPCError("BAD_REQUEST", {
      message: "That bot is already linked to a chat app; unlink it first.",
    });
    expect(rpcErrorMessage(error, "Couldn't update")).toBe(
      "That bot is already linked to a chat app; unlink it first.",
    );
  });

  it("keeps the generic copy for other codes, blank messages, and plain errors", () => {
    expect(
      rpcErrorMessage(new ORPCError("NOT_FOUND", { message: "bot missing" }), "Couldn't update"),
    ).toBe("Couldn't update");
    expect(
      rpcErrorMessage(
        new ORPCError("INTERNAL_SERVER_ERROR", { message: "stack trace" }),
        "Couldn't update",
      ),
    ).toBe("Couldn't update");
    expect(
      rpcErrorMessage(new ORPCError("BAD_REQUEST", { message: "  " }), "Couldn't update"),
    ).toBe("Couldn't update");
    expect(rpcErrorMessage(new Error("network down"), "Couldn't update")).toBe("Couldn't update");
    expect(rpcErrorMessage(undefined, "Couldn't update")).toBe("Couldn't update");
  });
});
