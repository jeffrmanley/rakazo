import { randomUUID } from "node:crypto";
import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  AgentToolExecutionObserver,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { builtinAgentTools, PiAgentRuntime } from "@rakazo/adapters";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelEmulatorRequest } from "./model-emulator.js";
import { startModelEmulator } from "./model-emulator.js";

/**
 * Fork extensions on the real Pi runtime: the model's stated reason reaches the executor with
 * the call (approvals).
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const notesTool: ConnectorTool = {
  name: "read_notes",
  description: "Read a note",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
};
const writeTool = builtinAgentTools.find((tool) => tool.name === "write_file")!;
const subagentTool = builtinAgentTools.find((tool) => tool.name === "run_subagent")!;

function request(model: AgentRunRequest["model"], overrides: Partial<AgentRunRequest>) {
  return {
    botId: "fixture-bot",
    threadId: "fixture-thread",
    runId: randomUUID(),
    prompt: "Do the task.",
    instructions: "Complete the requested task.",
    history: [],
    tools: [writeTool, notesTool, subagentTool],
    model,
    ...overrides,
  } satisfies AgentRunRequest;
}

async function drain(stream: AsyncIterable<AgentRuntimeEvent>) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const isSubagent = (req: ModelEmulatorRequest) =>
  JSON.stringify(req.messages[0]?.content ?? "").includes("subagent");

describe("Pi runtime governance hooks", () => {
  it("passes the turn's own text to the executor as the stated reason, and nothing when there is none", async () => {
    const turns = [
      {
        type: "tool" as const,
        id: "with-reason",
        name: "write_file",
        arguments: { path: "a.txt", content: "a" },
        assistantText: "Saving the note because you asked for it.",
      },
      {
        type: "tool" as const,
        id: "without-reason",
        name: "write_file",
        arguments: { path: "b.txt", content: "b" },
      },
      { type: "text" as const, text: "Done." },
    ];
    const server = await startModelEmulator({
      steps: (_req, index) => ({ expect() {}, response: turns[index]! }),
    });
    cleanups.push(() => server.close());
    const reasons: Array<string | undefined> = [];
    await drain(
      new PiAgentRuntime().run(
        request(server.model, {
          async executeTool(_name, _args, _id, _route, observer?: AgentToolExecutionObserver) {
            reasons.push(observer?.statedReason);
            return { ok: true };
          },
        }),
      ),
    );
    server.assertComplete();
    expect(reasons).toEqual(["Saving the note because you asked for it.", ""]);
  });
});
