import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioEmulator } from "@rakazo/adapters";
import { loadExtEnv } from "@rakazo/core";
import type { AuditEvent } from "@rakazo/db";
import {
  AuditWriteError,
  createAuditWriter,
  installAuditWriter,
  verifyAuditChain,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
type Handles = Awaited<ReturnType<typeof createApp>>;
process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeAudit = hasDb ? describe.sequential : describe.skip;

describeAudit("fork extension: audit log end to end", () => {
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-audit-"));
  let handles: Handles;
  let app: App;
  let prisma: Handles["prisma"];
  let cookieA: string;
  let cookieB: string;
  let spaceA: string;
  let userA: string;
  let botId: string;
  let runId: string;
  let events: AuditEvent[];

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      composio: new ComposioEmulator(),
      ext: { ...loadExtEnv({}), auditLog: true },
    });
    app = handles.app;
    prisma = handles.prisma;
    cookieA = await signup(app, `audit-a-${stamp}@rakazo.test`, "Audit A");
    cookieB = await signup(app, `audit-b-${stamp}@rakazo.test`, "Audit B");
    const bot = await rpc<{ id: string }>(app, cookieA, "bots/create", {
      name: "Auditor",
      title: "Auditor",
      description: "Runs commands",
      instructions: "Run commands.",
    });
    botId = bot.id;
    await discardBotIntroRun(handles, cookieA, botId);
    const row = await prisma.bot.findUniqueOrThrow({
      where: { id: botId },
      select: { spaceId: true, userId: true },
    });
    spaceA = row.spaceId;
    userA = row.userId;
  });

  afterAll(async () => {
    await handles?.stop();
  });

  it("records the inbound message, the tool call and result, and the reply in one chain", async () => {
    const sent = await rpc<{ runId: string }>(app, cookieA, "threads/send", {
      botId,
      text: "run the shell command echo audit-hello",
    });
    runId = sent.runId;
    await waitForRun(prisma, runId);

    const rows = await prisma.extAuditEvent.findMany({
      where: { spaceId: spaceA, OR: [{ runId }, { kind: "message.in" }] },
      orderBy: { seq: "asc" },
    });
    const kinds = rows.map((row) => row.kind);
    const indexOf = (kind: string) => kinds.lastIndexOf(kind);
    expect(indexOf("message.in")).toBeGreaterThanOrEqual(0);
    expect(indexOf("tool.call")).toBeGreaterThan(indexOf("message.in"));
    expect(indexOf("tool.result")).toBeGreaterThan(indexOf("tool.call"));
    // The scripted bot narrates before the tool runs, so its reply may precede the
    // call; what matters is that every reply of this run is on the chain.
    expect(indexOf("message.out")).toBeGreaterThan(indexOf("message.in"));

    const inbound = rows.filter((row) => row.kind === "message.in").at(-1)!;
    expect(inbound).toMatchObject({ actorType: "human", actorId: userA, botId });
    const call = rows.find((row) => row.kind === "tool.call")!;
    expect(call).toMatchObject({ runId, botId, actorType: "bot", actorId: botId });
    expect(call.detail).toMatchObject({ name: "shell", args: { command: "echo audit-hello" } });
    const result = rows.find((row) => row.kind === "tool.result")!;
    expect(result.detail).toMatchObject({ name: "shell", outcome: "succeeded" });
    const outbound = rows.filter((row) => row.kind === "message.out").at(-1)!;
    expect(outbound).toMatchObject({ runId, actorType: "bot", actorId: botId });
    for (const row of rows) {
      expect(JSON.stringify(row.detail)).not.toContain("audit-hello\n");
    }
    await expect(verifyAuditChain(prisma, { spaceId: spaceA })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("serves the chain to the session's space only, whatever the query says", async () => {
    const res = await get(app, cookieA, "/api/v1/audit?limit=100");
    expect(res.status).toBe(200);
    const page = (await res.json()) as { events: AuditEvent[]; nextCursor: string | null };
    events = page.events;
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events.every((event) => event.spaceId === spaceA)).toBe(true);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));

    const byRun = (await (await get(app, cookieA, `/api/v1/audit?runId=${runId}`)).json()) as {
      events: AuditEvent[];
    };
    expect(byRun.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["tool.call", "tool.result", "message.out"]),
    );
    expect(byRun.events.every((event) => event.runId === runId)).toBe(true);

    const paged = (await (await get(app, cookieA, "/api/v1/audit?limit=2")).json()) as {
      events: AuditEvent[];
      nextCursor: string | null;
    };
    expect(paged.events.map((event) => event.seq)).toEqual([0, 1]);
    expect(paged.nextCursor).toBe("1");
    const rest = (await (
      await get(app, cookieA, `/api/v1/audit?limit=100&cursor=${paged.nextCursor}`)
    ).json()) as { events: AuditEvent[] };
    expect(rest.events[0]?.seq).toBe(2);

    // Another member's session sees only their own space, and a spoofed space id changes nothing.
    const spoofedQuery = (await (
      await get(app, cookieB, `/api/v1/audit?spaceId=${spaceA}&space_id=${spaceA}`)
    ).json()) as { events: AuditEvent[] };
    expect(spoofedQuery.events.some((event) => event.spaceId === spaceA)).toBe(false);
    const spoofedHeader = await app.request("/api/v1/audit", {
      headers: { cookie: cookieB, origin: "http://127.0.0.1:5173", "x-rakazo-space-id": spaceA },
    });
    expect(spoofedHeader.status).toBe(401);
    const spoofedBody = await app.request("/api/v1/audit", {
      method: "POST",
      headers: {
        cookie: cookieB,
        origin: "http://127.0.0.1:5173",
        "content-type": "application/json",
      },
      body: JSON.stringify({ spaceId: spaceA }),
    });
    expect(spoofedBody.status).toBe(404);
    expect((await app.request("/api/v1/audit")).status).toBe(401);
  });

  it("fails closed: when the audit insert fails the message is not accepted and the error carries an id", async () => {
    const failing = () => Promise.reject(new AuditWriteError(new Error("audit storage down")));
    installAuditWriter({ record: failing, recordInTransaction: failing });
    const thread = await prisma.thread.findUniqueOrThrow({ where: { botId } });
    const messagesBefore = await prisma.message.count({ where: { threadId: thread.id } });
    const auditBefore = await prisma.extAuditEvent.count({ where: { spaceId: spaceA } });
    try {
      const res = await app.request("/rpc/threads/send", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: cookieA,
          origin: "http://127.0.0.1:5173",
        },
        body: JSON.stringify({ json: { botId, text: "this must not be stored" } }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as {
        json?: { message?: string; data?: { error_id?: string } };
      };
      const message = body.json?.message ?? "";
      expect(message).toMatch(/^Internal error \(error_id: [0-9a-f-]{36}\)$/);
      expect(body.json?.data?.error_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.stringify(body)).not.toContain("audit storage down");
    } finally {
      installAuditWriter(createAuditWriter(prisma));
    }
    await expect(prisma.message.count({ where: { threadId: thread.id } })).resolves.toBe(
      messagesBefore,
    );
    await expect(prisma.extAuditEvent.count({ where: { spaceId: spaceA } })).resolves.toBe(
      auditBefore,
    );
    await expect(
      prisma.message.count({
        where: {
          threadId: thread.id,
          blocks: { array_contains: [{ kind: "text", text: "this must not be stored" }] },
        },
      }),
    ).resolves.toBe(0);
  });

  it("changes nothing when EXT_AUDIT_LOG is off", async () => {
    await handles.stop();
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir: mkdtempSync(path.join(tmpdir(), "rakazo-audit-off-")),
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      composio: new ComposioEmulator(),
      ext: loadExtEnv({}),
    });
    app = handles.app;
    prisma = handles.prisma;
    const cookie = await signup(app, `audit-off-${stamp}@rakazo.test`, "Audit Off");
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Quiet",
      title: "Quiet",
      description: "No audit",
      instructions: "Run commands.",
    });
    await discardBotIntroRun(handles, cookie, bot.id);
    const { spaceId } = await prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      select: { spaceId: true },
    });
    const sent = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId: bot.id,
      text: "run the shell command echo unaudited",
    });
    await waitForRun(prisma, sent.runId);
    await expect(prisma.extAuditEvent.count({ where: { spaceId } })).resolves.toBe(0);
    await expect(prisma.extAuditChainHead.count({ where: { spaceId } })).resolves.toBe(0);
    expect((await app.request("/api/v1/audit", { headers: { cookie } })).status).toBe(404);
  });
});

async function signup(app: App, email: string, name: string) {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (res.status >= 400) throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  return sessionCookieHeader(res);
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
  });
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}

function get(app: App, cookie: string, url: string) {
  return app.request(url, { headers: { cookie, origin: "http://127.0.0.1:5173" } });
}

async function waitForRun(prisma: Handles["prisma"], runId: string) {
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: { status: true, error: true },
    });
    if (run && ["completed", "failed", "cancelled"].includes(run.status)) {
      if (run.status !== "completed")
        throw new Error(`run ${runId} ended ${run.status}: ${run.error}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for run ${runId}`);
}
