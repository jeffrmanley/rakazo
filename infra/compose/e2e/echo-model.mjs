// Minimal OpenAI-compatible streaming model for the local compose E2E stack.
// Replies "echo: <last user text>" and reports usage with a configurable cost so
// budget metering has real numbers. Test-only; never deployed.
import { createServer } from "node:http";

const port = Number(process.env.ECHO_MODEL_PORT ?? 8080);
const costPerCall = Number(process.env.ECHO_MODEL_COST_USD ?? 0.5);
const delayMs = Number(process.env.ECHO_MODEL_DELAY_MS ?? 0);
const calls = [];

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content))
      return m.content
        .filter((p) => p && p.type === "text")
        .map((p) => p.text)
        .join(" ");
  }
  return "";
}

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/__calls") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(calls));
    return;
  }
  if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "echo-1", object: "model" }] }));
    return;
  }
  if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const text = lastUserText(body.messages ?? []).trim();
  // Strip any harness/system wrapping and keep the reply short and deterministic.
  const reply = `echo: ${text.split("\n").at(-1)?.slice(0, 200) ?? ""}`;
  calls.push({ at: new Date().toISOString(), model: body.model, text });
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  const usage = {
    prompt_tokens: 1000,
    completion_tokens: 50,
    total_tokens: 1050,
    cost: costPerCall,
  };
  const base = {
    id: `echo-${calls.length}`,
    object: "chat.completion.chunk",
    created: 0,
    model: body.model,
  };
  if (body.stream === false) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ...base,
        object: "chat.completion",
        choices: [
          { index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" },
        ],
        usage,
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const emit = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  emit({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  emit({ ...base, choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] });
  emit({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  emit({ ...base, choices: [], usage });
  res.end("data: [DONE]\n\n");
}).listen(port, "0.0.0.0", () => console.log(`echo model on :${port}`));
