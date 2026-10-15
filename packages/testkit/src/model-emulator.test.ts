import { afterEach, describe, expect, it } from "vitest";
import { startModelEmulator } from "./model-emulator.js";

const servers: Array<Awaited<ReturnType<typeof startModelEmulator>>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function post(server: Awaited<ReturnType<typeof startModelEmulator>>, overrides = {}) {
  return fetch(`${server.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer local", "content-type": "application/json" },
    body: JSON.stringify({
      model: server.model.id,
      stream: true,
      messages: [{ role: "user", content: "fixture" }],
      ...overrides,
    }),
  });
}

describe("model HTTP emulator contract", () => {
  it("fails locally when a request assertion fails, even if the caller ignores the HTTP error", async () => {
    const server = await startModelEmulator({
      steps: [
        {
          expect(request) {
            expect(request.messages.at(-1)?.content).toBe("required task");
          },
          response: { type: "text", text: "must not be returned" },
        },
      ],
    });
    servers.push(server);
    const response = await post(server);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("must not be returned");
    expect(() => server.assertComplete()).toThrow(/required task/);
  });

  it("rejects incomplete scenarios and unexpected extra model requests", async () => {
    const server = await startModelEmulator({
      steps: [{ expect() {}, response: { type: "text", text: "fixture" } }],
    });
    servers.push(server);
    expect(() => server.assertComplete()).toThrow(/Not all model fixture steps/);
    expect((await post(server)).status).toBe(200);
    server.assertComplete();
    expect((await post(server)).status).toBe(400);
    expect(() => server.assertComplete()).toThrow(/Unexpected model request 2/);
  });

  it("rejects a request routed to the wrong model", async () => {
    const server = await startModelEmulator({ steps: [] });
    servers.push(server);
    expect((await post(server, { model: "wrong-model" })).status).toBe(400);
    expect(() => server.assertComplete()).toThrow(/Model routing changed/);
  });

  it("requires argument fragments to faithfully represent the scripted tool arguments", async () => {
    const server = await startModelEmulator({
      steps: [
        {
          expect() {},
          response: {
            type: "tool",
            id: "bad-fragments",
            name: "write_file",
            arguments: { path: "file" },
            argumentChunks: ["{}"],
          },
        },
      ],
    });
    servers.push(server);
    expect((await post(server)).status).toBe(400);
    expect(() => server.assertComplete()).toThrow();
  });

  it("streams parallel tool calls in one turn and serves an open-ended script", async () => {
    const seen: number[] = [];
    const server = await startModelEmulator({
      steps: (_request, index) => {
        seen.push(index);
        return {
          expect() {},
          response: {
            type: "tools",
            calls: [
              { id: "a", name: "message_bot", arguments: { message: "one" } },
              { id: "b", name: "message_bot", arguments: { message: "two" } },
            ],
          },
        };
      },
    });
    servers.push(server);
    for (let n = 0; n < 3; n += 1) {
      const response = await post(server);
      expect(response.status).toBe(200);
      const chunks = (await response.text())
        .split("\n\n")
        .filter((line) => line.startsWith("data: {"))
        .map(
          (line) =>
            JSON.parse(line.slice(6)) as {
              choices: Array<{
                delta: { tool_calls?: Array<{ index: number; id?: string }> };
                finish_reason: string | null;
              }>;
            },
        );
      const calls = chunks.flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? []);
      expect(calls.map((call) => [call.index, call.id])).toEqual([
        [0, "a"],
        [1, "b"],
      ]);
      expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("tool_calls");
    }
    expect(seen).toEqual([0, 1, 2]);
    server.assertComplete();
  });
});
