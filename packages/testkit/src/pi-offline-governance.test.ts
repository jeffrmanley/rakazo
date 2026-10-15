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
 * the call (approvals), and every model-issued call the executor never sees is still offered
 * to the audit hook (audit log).
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

  it("offers every call the executor never sees to the audit hook, once", async () => {
    const server = await startModelEmulator({
      steps: (req, index) => {
        if (isSubagent(req))
          return { expect() {}, response: { type: "text", text: "Helper done." } };
        return {
          expect() {},
          response:
            index === 0
              ? {
                  type: "tools",
                  calls: [
                    { id: "unknown", name: "set_budget", arguments: { dailyUsd: 1000 } },
                    { id: "invalid", name: "read_notes", arguments: {} },
                    { id: "helper", name: "run_subagent", arguments: { name: "h", task: "t" } },
                    { id: "valid", name: "write_file", arguments: { path: "c.txt", content: "c" } },
                  ],
                }
              : { type: "text", text: "Done." },
        };
      },
    });
    cleanups.push(() => server.close());
    const executed: string[] = [];
    const audited: Array<{ name: string; executionId: string; args: unknown; result: unknown }> =
      [];
    await drain(
      new PiAgentRuntime().run(
        request(server.model, {
          async executeTool(name) {
            executed.push(name);
            return { ok: true };
          },
          async auditToolCall(name, args, executionId, run) {
            const result = await run();
            audited.push({ name, executionId, args, result });
            return result;
          },
        }),
      ),
    );
    server.assertComplete();
    expect(executed).toEqual(["write_file"]);
    const byName = Object.fromEntries(audited.map((entry) => [entry.name, entry]));
    expect(Object.keys(byName).sort()).toEqual(["read_notes", "run_subagent", "set_budget"]);
    expect(audited).toHaveLength(3);
    expect(byName.set_budget).toMatchObject({
      executionId: JSON.stringify(["pi-tool", "main", "unknown"]),
      args: { dailyUsd: 1000 },
      result: { error: "Tool set_budget not found" },
    });
    expect(JSON.stringify(byName.read_notes!.result)).toMatch(/error/);
    expect(byName.run_subagent).toMatchObject({
      executionId: JSON.stringify(["pi-tool", "main", "helper"]),
      args: { name: "h", task: "t" },
    });
    expect(JSON.stringify(byName.run_subagent!.result)).toContain("Helper done.");
  });

  it("does not run an in-process tool when its audit record fails", async () => {
    const server = await startModelEmulator({
      steps: (req, index) => ({
        expect() {},
        response: isSubagent(req)
          ? { type: "text", text: "Helper must not run." }
          : index === 0
            ? {
                type: "tool",
                id: "helper",
                name: "run_subagent",
                arguments: { name: "h", task: "t" },
              }
            : { type: "text", text: "Done." },
      }),
    });
    cleanups.push(() => server.close());
    await drain(
      new PiAgentRuntime().run(
        request(server.model, {
          async executeTool() {
            return { ok: true };
          },
          async auditToolCall() {
            throw new Error("audit store unavailable");
          },
        }),
      ),
    ).catch(() => undefined);
    expect(server.requests.some(isSubagent)).toBe(false);
  });
});
