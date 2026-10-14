import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { budgetAfterModelCall, ComposioEmulator } from "@rakazo/adapters";
import {
  BUDGET_BLOCK_TEXT,
  BUDGET_SPACE_BLOCK_TEXT,
  BUDGET_STOP_TEXT,
  loadExtEnv,
  PREMIUM_MODEL_REFUSAL,
} from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { createApp } from "../../../apps/api/src/app.ts";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { startModelEmulator } from "./model-emulator.js";

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

type Handles = Awaited<ReturnType<typeof createApp>>;
type App = Handles["app"];

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeBudgets = hasDb ? describe.sequential : describe.skip;
const origin = "http://127.0.0.1:5173";
const budgetsOn = { ...loadExtEnv({}), auditLog: true, budgets: true };

describeBudgets("fork extension: budgets end to end (scripted runtime)", () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-budgets-"));
  let handles: Handles;
  let app: App;
  let prisma: Handles["prisma"];

  beforeAll(async () => {
    const { createApp } = await import("../../../apps/api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      defaultProvider: "scripted",
      defaultModel: "scripted",
      composio: new ComposioEmulator(),
      ext: budgetsOn,
    });
    app = handles.app;
    prisma = handles.prisma;
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function newOwner(label: string) {
    const cookie = await signup(app, `budget-${label}-${stamp}@rakazo.test`, `Budget ${label}`);
    const me = await rpc<{ userId: string; spaceId: string }>(app, cookie, "me");
    return { cookie, ...me };
  }

  async function newBot(owner: { cookie: string }, name: string, extra: object = {}) {
    const bot = await rpc<{ id: string }>(app, owner.cookie, "bots/create", {
      name,
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
      ...extra,
    });
    await discardBotIntroRun(handles, owner.cookie, bot.id);
    return bot.id;
  }

  async function spend(owner: { userId: string; spaceId: string }, botId: string, costUsd: number) {
    await prisma.usageRecord.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId,
        provider: "fixture",
        model: "fixture",
        costUsd,
      },
    });
  }

  async function lastBotText(runId: string) {
    const message = await prisma.message.findFirst({
      where: { runId, role: "bot" },
      orderBy: { seq: "desc" },
      select: { blocks: true },
    });
    const blocks = (message?.blocks ?? []) as Array<{ kind: string; text?: string }>;
    return blocks.find((block) => block.kind === "text")?.text;
  }

  it("refuses a bot over its daily cap with a chat notice and a budget.block event", async () => {
    const owner = await newOwner("over");
    const botId = await newBot(owner, "Over budget");
    await spend(owner, botId, 3);

    const { runId } = await rpc<{ runId: string }>(app, owner.cookie, "threads/send", {
      botId,
      text: "write a file that says refused",
    });
    await waitForRun(prisma, runId);
    expect(await lastBotText(runId)).toBe(BUDGET_BLOCK_TEXT);
    expect(await prisma.attempt.count({ where: { runId } })).toBe(1);
    const blocks = await prisma.extAuditEvent.findMany({
      where: { spaceId: owner.spaceId, kind: "budget.block", runId },
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.detail).toMatchObject({ scope: "bot", spentUsd: 3, capUsd: 3 });
  });

  it("blocks every bot in a space over the space cap", async () => {
    const owner = await newOwner("space");
    const spender = await newBot(owner, "Spender");
    const other = await newBot(owner, "Other");
    const put = await call(app, owner.cookie, "PUT", "/api/v1/budgets/space", { dailyUsd: 2 });
    expect(put.status).toBe(200);
    await spend(owner, spender, 2);

    const { runId } = await rpc<{ runId: string }>(app, owner.cookie, "threads/send", {
      botId: other,
      text: "hello",
    });
    await waitForRun(prisma, runId);
    expect(await lastBotText(runId)).toBe(BUDGET_SPACE_BLOCK_TEXT);
    const changes = await prisma.extAuditEvent.findMany({
      where: { spaceId: owner.spaceId, kind: "policy.change" },
    });
    expect(changes.map((event) => event.detail)).toContainEqual(
      expect.objectContaining({ target: "space", dailyUsd: 2 }),
    );
  });

  it("unblocks for today only after a space owner tops up", async () => {
    const owner = await newOwner("topup");
    const botId = await newBot(owner, "Topped up");
    await spend(owner, botId, 3);

    const blocked = await rpc<{ runId: string }>(app, owner.cookie, "threads/send", {
      botId,
      text: "first",
    });
    await waitForRun(prisma, blocked.runId);
    expect(await lastBotText(blocked.runId)).toBe(BUDGET_BLOCK_TEXT);

    const topUp = await call(app, owner.cookie, "POST", `/api/v1/budgets/bots/${botId}/top-up`, {
      amountUsd: 2,
    });
    expect(topUp.status).toBe(201);
    const body = (await topUp.json()) as { day: string; expiresAt: string; amountUsd: number };
    const today = new Date().toISOString().slice(0, 10);
    expect(body).toMatchObject({ day: today, amountUsd: 2 });
    expect(new Date(body.expiresAt).getTime() - Date.parse(`${today}T00:00:00Z`)).toBe(86_400_000);

    const allowed = await rpc<{ runId: string }>(app, owner.cookie, "threads/send", {
      botId,
      text: "write a file that says allowed",
    });
    await waitForRun(prisma, allowed.runId);
    expect(await lastBotText(allowed.runId)).not.toBe(BUDGET_BLOCK_TEXT);

    const view = (await (
      await call(app, owner.cookie, "GET", `/api/v1/budgets/bots/${botId}`)
    ).json()) as { bot: { capUsd: number; topUpUsd: number; level: string } };
    expect(view.bot).toMatchObject({ capUsd: 5, topUpUsd: 2 });
    // The top-up is stored against today's UTC day only; tomorrow's cap is the profile again.
    const rows = await prisma.extBudgetTopUp.findMany({ where: { spaceId: owner.spaceId } });
    expect(rows.map((row) => row.day)).toEqual([today]);
    const audit = await prisma.extAuditEvent.findFirst({
      where: { spaceId: owner.spaceId, kind: "policy.change", botId },
    });
    expect(audit?.detail).toMatchObject({ target: "bot", amountUsd: 2, day: today });
  });

  it("skips a routine over budget without running or retrying it", async () => {
    const owner = await newOwner("routine");
    const botId = await newBot(owner, "Routine bot");
    const routine = await rpc<{ id: string }>(app, owner.cookie, "routines/create", {
      botId,
      name: "Daily",
      prompt: "write a file that says routine",
      crons: ["0 9 * * *"],
      timezone: "UTC",
      active: true,
    });
    await spend(owner, botId, 5);
    const due = new Date(Date.now() - 60_000);
    await prisma.routine.update({ where: { id: routine.id }, data: { nextRunAt: due } });

    await handles.executor.wakeRoutine(routine.id, due.toISOString());
    // A second delivery of the same wake (a retry) finds the schedule already advanced.
    await handles.executor.wakeRoutine(routine.id, due.toISOString());

    expect(await prisma.run.count({ where: { routineId: routine.id } })).toBe(0);
    const after = await prisma.routine.findUniqueOrThrow({ where: { id: routine.id } });
    expect(after.active).toBe(true);
    expect(after.lastRunAt).toBeNull();
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    const skipped = await prisma.extAuditEvent.findMany({
      where: { spaceId: owner.spaceId, kind: "budget.block", botId },
    });
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.detail).toMatchObject({ reason: "routine_skipped", routineId: routine.id });
  });

  it("queues a third run while two run (cap 2, two workers) and starts it when a slot frees", async () => {
    const owner = await newOwner("concurrency");
    const botId = await newBot(owner, "Parallel", { computerMode: "dedicated" });
    const thread = await prisma.thread.findUniqueOrThrow({ where: { botId } });
    const runs = await Promise.all(
      [1, 2, 3].map(async () => {
        const task = await prisma.task.create({
          data: {
            spaceId: owner.spaceId,
            botId,
            threadId: thread.id,
            userId: owner.userId,
            prompt: "keep working",
            status: "queued",
          },
        });
        return prisma.run.create({
          data: {
            spaceId: owner.spaceId,
            botId,
            threadId: thread.id,
            taskId: task.id,
            userId: owner.userId,
            status: "queued",
            trigger: "user",
          },
        });
      }),
    );
    const ids = runs.map((run) => run.id);
    const pending = ids.map((id, index) =>
      handles.executor.continueRun(id, index % 2 === 0 ? "worker-a" : "worker-b"),
    );
    const statuses = async () =>
      (
        await prisma.run.findMany({
          where: { id: { in: ids } },
          select: { id: true, status: true },
        })
      )
        .map((run) => run.status)
        .sort();
    await expect
      .poll(statuses, { timeout: 15_000, interval: 50 })
      .toEqual(["queued", "running", "running"]);
    // Hold the state for a moment: the queued run's retries must keep it queued.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(await statuses()).toEqual(["queued", "running", "running"]);
    const queued = (await prisma.run.findFirstOrThrow({
      where: { id: { in: ids }, status: "queued" },
    }))!;
    expect(await prisma.attempt.count({ where: { runId: queued.id } })).toBe(0);

    const first = ids.find((id) => id !== queued.id)!;
    await handles.runtime.abort(first);
    await expect
      .poll(async () => (await prisma.run.findUniqueOrThrow({ where: { id: queued.id } })).status, {
        timeout: 15_000,
        interval: 50,
      })
      .toBe("running");
    // A run counts as running before its runtime starts, so keep stopping until all have ended.
    await expect
      .poll(
        async () => {
          for (const id of ids) await handles.runtime.abort(id);
          return prisma.run.count({
            where: { id: { in: ids }, status: { in: ["running", "leased"] } },
          });
        },
        { timeout: 15_000, interval: 100 },
      )
      .toBe(0);
    await Promise.all(pending);
  });

  it("sends the 80% notice once, in chat through the bot's home messaging identity", async () => {
    const owner = await newOwner("notice");
    const botId = await newBot(owner, "Chatty");
    const identity = await prisma.messagingIdentity.create({
      data: {
        provider: "slack",
        address: `U-${stamp}`,
        userId: owner.userId,
        spaceId: owner.spaceId,
        botId,
        verifiedAt: new Date(),
      },
    });
    await prisma.bot.update({
      where: { id: botId },
      data: { homeMessagingIdentityId: identity.id },
    });
    await spend(owner, botId, 2.5);
    const deps = { prisma, jobs: handles.jobs, events: {} as never };
    const run = { spaceId: owner.spaceId, botId };

    // 83%: notified, not halted. A second crossing the same UTC day sends nothing.
    await expect(budgetAfterModelCall(deps, run)).resolves.toBe(false);
    await spend(owner, botId, 0.5);
    await expect(budgetAfterModelCall(deps, run)).resolves.toBe(true);
    const sent = await prisma.messagingOutbound.findMany({ where: { identityId: identity.id } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: "dm",
      body: "Chatty has used $2.50 of its $3.00 daily budget.",
    });
    // Tomorrow is a new budget day with its own notice.
    const tomorrow = new Date(Date.now() + 86_400_000);
    await prisma.usageRecord.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId,
        provider: "fixture",
        model: "fixture",
        costUsd: 2.7,
        createdAt: tomorrow,
      },
    });
    await budgetAfterModelCall(deps, run, tomorrow);
    expect(await prisma.messagingOutbound.count({ where: { identityId: identity.id } })).toBe(2);
  });

  it("alerts the space owner once per month at $400", async () => {
    const owner = await newOwner("monthly");
    const botId = await newBot(owner, "Monthly");
    const identity = await prisma.messagingIdentity.create({
      data: {
        provider: "slack",
        address: `U-month-${stamp}`,
        userId: owner.userId,
        spaceId: owner.spaceId,
        botId,
      },
    });
    const deps = { prisma, jobs: handles.jobs, events: {} as never };
    await spend(owner, botId, 399.99);
    await budgetAfterModelCall(deps, { spaceId: owner.spaceId, botId });
    const monthly = () =>
      prisma.messagingOutbound.findMany({
        where: { identityId: identity.id, body: { contains: "this month" } },
      });
    expect(await monthly()).toHaveLength(0);
    await spend(owner, botId, 0.01);
    await budgetAfterModelCall(deps, { spaceId: owner.spaceId, botId });
    await budgetAfterModelCall(deps, { spaceId: owner.spaceId, botId });
    const alerts = await monthly();
    expect(alerts.map((row) => row.body)).toEqual(["This space has spent $400.00 this month."]);
  });

  it("keeps each space's budgets private and ignores a spoofed spaceId", async () => {
    const a = await newOwner("tenant-a");
    const b = await newOwner("tenant-b");
    const botA = await newBot(a, "Private");
    await spend(a, botA, 1.5);

    for (const [method, url, body] of [
      ["GET", `/api/v1/budgets/bots/${botA}`, undefined],
      ["PUT", `/api/v1/budgets/bots/${botA}`, { profile: "swarm" }],
      ["POST", `/api/v1/budgets/bots/${botA}/top-up`, { amountUsd: 5 }],
    ] as const) {
      expect((await call(app, b.cookie, method, url, body)).status).toBe(404);
    }

    const spoofedRead = await call(
      app,
      b.cookie,
      "GET",
      `/api/v1/budgets/space?spaceId=${a.spaceId}`,
    );
    expect(spoofedRead.status).toBe(200);
    expect(await spoofedRead.json()).toMatchObject({ spentUsd: 0, canManage: true });

    const spoofedWrite = await call(app, b.cookie, "PUT", "/api/v1/budgets/space", {
      dailyUsd: 7,
      spaceId: a.spaceId,
    });
    expect(spoofedWrite.status).toBe(200);
    expect(await prisma.extSpaceBudget.findUnique({ where: { spaceId: a.spaceId } })).toBeNull();
    expect(
      (await prisma.extSpaceBudget.findUniqueOrThrow({ where: { spaceId: b.spaceId } })).dailyUsd,
    ).toBe(7);

    const spoofedTopUp = await call(app, b.cookie, "POST", "/api/v1/budgets/space/top-up", {
      amountUsd: 3,
      spaceId: a.spaceId,
    });
    expect(spoofedTopUp.status).toBe(201);
    expect(await prisma.extBudgetTopUp.count({ where: { spaceId: a.spaceId } })).toBe(0);

    // The space header only selects among the caller's own memberships.
    const header = await app.request("/api/v1/budgets/space", {
      headers: { cookie: b.cookie, origin, "x-rakazo-space-id": a.spaceId },
    });
    expect(header.status).toBe(401);
    expect((await call(app, "", "GET", "/api/v1/budgets/space")).status).toBe(401);
  });

  it("validates settings and keeps premium and limits to the API, audited", async () => {
    const owner = await newOwner("settings");
    const botId = await newBot(owner, "Settings");
    const bad = await call(app, owner.cookie, "PUT", `/api/v1/budgets/bots/${botId}`, {
      customDailyUsd: -1,
    });
    expect(bad.status).toBe(400);

    await expect(
      rpc(app, owner.cookie, "bots/update", {
        botId,
        modelProvider: "anthropic",
        modelId: "claude-fable-5",
      }),
    ).rejects.toThrow(PREMIUM_MODEL_REFUSAL);

    const saved = await call(app, owner.cookie, "PUT", `/api/v1/budgets/bots/${botId}`, {
      profile: "custom",
      customDailyUsd: 12,
      premium: true,
      maxConcurrentRuns: 1,
      maxSpawnDepth: 1,
      maxSpawnFanout: 3,
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      bot: { capUsd: 12, profile: "custom" },
      settings: { premium: true },
      limits: { maxConcurrentRuns: 1, maxSpawnDepth: 1, maxSpawnFanout: 3 },
      canSetPremium: true,
    });
    // Premium now passes the budget rule; the model still needs a connection.
    await expect(
      rpc(app, owner.cookie, "bots/update", {
        botId,
        modelProvider: "anthropic",
        modelId: "claude-fable-5",
      }),
    ).rejects.toThrow("Connect that model provider first");

    const change = await prisma.extAuditEvent.findFirst({
      where: { spaceId: owner.spaceId, kind: "policy.change", botId },
    });
    expect(change).toMatchObject({ actorType: "human", actorId: owner.userId });
    expect(change?.detail).toMatchObject({
      target: "bot",
      after: { profile: "custom", customDailyUsd: 12, premium: true },
    });
  });
});

describeBudgets("fork extension: budgets end to end (Pi with priced usage)", () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  async function startPiApp(steps: Parameters<typeof startModelEmulator>[0]["steps"]) {
    const model = await startModelEmulator({ steps });
    const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-budgets-pi-"));
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      realtimeDatabaseUrl: process.env.DATABASE_URL!,
      authUrl: origin,
      webOrigin: origin,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "pi",
      contextStrategy: "current",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      composio: new ComposioEmulator(),
      encryptionKey: "budgets-fixture-encryption-key",
      ext: budgetsOn,
    });
    const cookie = await signup(
      handles.app,
      `budget-pi-${Math.random()}-${stamp}@rakazo.test`,
      "Pi",
    );
    const me = await rpc<{ userId: string; spaceId: string }>(handles.app, cookie, "me");
    await rpc(handles.app, cookie, "models/connect", {
      provider: model.model.provider,
      modelId: model.model.id,
      baseUrl: model.baseUrl,
    });
    const newBot = async (name: string) => {
      const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
        name,
        title: "",
        description: "",
        instructions: "Complete the synthetic task.",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, bot.id);
      await rpc(handles.app, cookie, "bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
      });
      return bot.id;
    };
    const stop = async () => {
      await handles.stop();
      await model.close();
      rmSync(dataDir, { recursive: true, force: true });
    };
    return { model, handles, cookie, me, newBot, stop };
  }

  const priced = (cost: number) => ({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    cost,
  });

  it("finishes the model call that crosses the cap, then halts; notifies at 80% once", async () => {
    const offered: string[][] = [];
    const env = await startPiApp([
      {
        expect: (request) => {
          offered.push((request.tools ?? []).map((tool) => tool.function.name));
        },
        usage: priced(1.5),
        response: {
          type: "tool",
          id: "progress-1",
          name: "message_user",
          arguments: { message: "this must not be delivered" },
        },
      },
      { expect: () => {}, usage: priced(1), response: { type: "text", text: "Never requested." } },
    ]);
    try {
      const botId = await env.newBot("Spender");
      const thread = await env.handles.prisma.thread.findUniqueOrThrow({ where: { botId } });
      await env.handles.prisma.usageRecord.create({
        data: {
          spaceId: env.me.spaceId,
          userId: env.me.userId,
          botId,
          provider: "fixture",
          model: "fixture",
          costUsd: 2,
        },
      });
      const { runId } = await rpc<{ runId: string }>(env.handles.app, env.cookie, "threads/send", {
        botId,
        text: "Do the expensive task.",
      });
      await waitForRun(env.handles.prisma, runId);

      expect(env.model.requests).toHaveLength(1);
      expect(offered[0]?.length).toBeGreaterThan(0);
      for (const name of offered[0] ?? [])
        expect(name).not.toMatch(/budget|premium|top.?up|limit/i);
      const usage = await env.handles.prisma.usageRecord.findMany({ where: { runId } });
      expect(usage.map((row) => row.costUsd)).toEqual([1.5]);
      const messages = await env.handles.prisma.message.findMany({
        where: { threadId: thread.id },
        orderBy: { seq: "asc" },
        select: { role: true, blocks: true, runId: true },
      });
      const texts = messages.flatMap((message) =>
        (message.blocks as Array<{ kind: string; text?: string }>).map((block) => ({
          role: message.role,
          runId: message.runId,
          text: block.text,
        })),
      );
      expect(texts.some((entry) => entry.text === "this must not be delivered")).toBe(false);
      expect(texts.filter((entry) => entry.runId === runId).at(-1)).toMatchObject({
        role: "bot",
        text: BUDGET_STOP_TEXT,
      });
      const halt = await env.handles.prisma.extAuditEvent.findFirst({
        where: { spaceId: env.me.spaceId, kind: "budget.block", runId },
      });
      expect(halt?.detail).toMatchObject({ reason: "halted" });

      // 80% (and 100%) crossed: the owner gets one notice, in-app since no chat app is linked.
      const notices = texts.filter(
        (entry) => entry.role === "system" && entry.text?.includes("daily budget"),
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]?.text).toBe("Spender has used $3.50 of its $3.00 daily budget.");

      // A new request is refused at claim: no model call, and no second notice.
      const next = await rpc<{ runId: string }>(env.handles.app, env.cookie, "threads/send", {
        botId,
        text: "Try again.",
      });
      await waitForRun(env.handles.prisma, next.runId);
      expect(env.model.requests).toHaveLength(1);
      expect(
        await env.handles.prisma.extBudgetNotice.count({
          where: { spaceId: env.me.spaceId, kind: "bot.warn" },
        }),
      ).toBe(1);
    } finally {
      await env.stop();
    }
  });

  it("refuses delegations beyond fan-out and depth as tool errors and starts nothing", async () => {
    let targetId = "";
    const toolResult = (request: { messages: Array<{ role: string; content?: unknown }> }) => {
      const last = [...request.messages].reverse().find((message) => message.role === "tool");
      return JSON.stringify(last?.content ?? "");
    };
    const results: string[] = [];
    const env = await startPiApp([
      {
        expect: () => {},
        usage: priced(0.01),
        response: () => ({
          type: "tool",
          id: "delegate-1",
          name: "message_bot",
          arguments: { bot_id: targetId, message: "first request" },
        }),
      },
      {
        expect: (request) => {
          results.push(toolResult(request));
        },
        usage: priced(0.01),
        response: () => ({
          type: "tool",
          id: "delegate-2",
          name: "message_bot",
          arguments: { bot_id: targetId, message: "second request" },
        }),
      },
      {
        expect: (request) => {
          results.push(toolResult(request));
        },
        usage: priced(0.01),
        response: { type: "text", text: "Reported back instead." },
      },
      // Second run, depth limit 0: a bot message and an in-run sub-agent are both refused.
      {
        expect: () => {},
        usage: priced(0.01),
        response: () => ({
          type: "tool",
          id: "delegate-3",
          name: "message_bot",
          arguments: { bot_id: targetId, message: "third request" },
        }),
      },
      {
        expect: (request) => {
          results.push(toolResult(request));
        },
        usage: priced(0.01),
        response: {
          type: "tool",
          id: "helper-1",
          name: "run_subagent",
          arguments: { name: "helper", task: "Inspect the fixture." },
        },
      },
      {
        expect: (request) => {
          results.push(toolResult(request));
        },
        usage: priced(0.01),
        response: { type: "text", text: "Did it myself." },
      },
    ]);
    try {
      const delegator = await env.newBot("Delegator");
      targetId = await env.newBot("Target");
      // The target is over its own cap, so its delegated runs are refused without a model call
      // and cannot take a scripted step out of order.
      await env.handles.prisma.usageRecord.create({
        data: {
          spaceId: env.me.spaceId,
          userId: env.me.userId,
          botId: targetId,
          provider: "fixture",
          model: "fixture",
          costUsd: 3,
        },
      });
      const limit = await call(
        env.handles.app,
        env.cookie,
        "PUT",
        `/api/v1/budgets/bots/${delegator}`,
        {
          maxSpawnFanout: 1,
        },
      );
      expect(limit.status).toBe(200);

      const first = await rpc<{ runId: string }>(env.handles.app, env.cookie, "threads/send", {
        botId: delegator,
        text: "Ask the target twice.",
      });
      await waitForRun(env.handles.prisma, first.runId);
      expect(results[0]).not.toMatch(/Delegation refused/);
      expect(results[1]).toMatch(
        /Delegation refused: this run already started 1 delegations, the limit is 1/,
      );
      expect(
        await env.handles.prisma.run.count({ where: { botId: targetId, trigger: "bot_message" } }),
      ).toBe(1);
      const lineage = await env.handles.prisma.extRunSpawn.findMany({
        where: { parentRunId: first.runId },
      });
      expect(lineage).toEqual([
        expect.objectContaining({ tool: "message_bot", depth: 1, childRunId: expect.any(String) }),
      ]);

      await call(env.handles.app, env.cookie, "PUT", `/api/v1/budgets/bots/${delegator}`, {
        maxSpawnDepth: 0,
        maxSpawnFanout: 5,
      });
      const second = await rpc<{ runId: string }>(env.handles.app, env.cookie, "threads/send", {
        botId: delegator,
        text: "Delegate again.",
      });
      await waitForRun(env.handles.prisma, second.runId);
      expect(results[2]).toMatch(
        /Delegation refused: this run is already at the delegation depth limit \(0\)/,
      );
      expect(results[3]).toMatch(/Delegation refused/);
      expect(
        await env.handles.prisma.run.count({ where: { botId: targetId, trigger: "bot_message" } }),
      ).toBe(1);
      expect(
        await env.handles.prisma.usageRecord.count({
          where: { runId: second.runId, operationKind: "subagent" },
        }),
      ).toBe(0);
      expect(env.model.requests).toHaveLength(6);
    } finally {
      await env.stop();
    }
  });
});

describeBudgets("fork extension: premium models", () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  /**
   * The executor with a recording runtime: each request shows the model the run selected,
   * its backups and its sub-agent model resolver, without calling a model.
   */
  async function startPremiumApp(connectedModelId: string) {
    const model = await startModelEmulator({ steps: [], modelId: connectedModelId });
    const requests: AgentRunRequest[] = [];
    const runtime: AgentRuntime = {
      describe: () => ({
        id: "recording",
        contractVersion: "1",
        adapterVersion: "0.0.0",
        capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
      }),
      async *run(request) {
        requests.push(request);
        yield { type: "text", text: "Recorded." };
        yield { type: "done", text: "Recorded." };
      },
      abort: async () => {},
    };
    const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-budgets-premium-"));
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "pi",
      runtime,
      wakeupDriver: "memory",
      composio: new ComposioEmulator(),
      encryptionKey: "budgets-premium-encryption-key",
      ext: budgetsOn,
    });
    const app = handles.app;
    const cookie = await signup(app, `budget-premium-${Math.random()}-${stamp}@rakazo.test`, "Pr");
    const me = await rpc<{ userId: string; spaceId: string }>(app, cookie, "me");
    await rpc(app, cookie, "models/connect", {
      provider: model.model.provider,
      modelId: model.model.id,
      baseUrl: model.baseUrl,
    });
    const newBot = async (withModel: boolean) => {
      const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
        name: "Thrifty",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, bot.id);
      if (withModel) {
        await rpc(app, cookie, "bots/update", {
          botId: bot.id,
          modelProvider: model.model.provider,
          modelId: model.model.id,
        });
      }
      requests.length = 0;
      return bot.id;
    };
    const send = async (botId: string, text: string) => {
      const { runId } = await rpc<{ runId: string }>(app, cookie, "threads/send", { botId, text });
      await waitForRun(handles.prisma, runId);
      return runId;
    };
    const makePremium = async (botId: string) => {
      const res = await call(app, cookie, "PUT", `/api/v1/budgets/bots/${botId}`, {
        premium: true,
      });
      expect(res.status).toBe(200);
    };
    const stop = async () => {
      await handles.stop();
      await model.close();
      rmSync(dataDir, { recursive: true, force: true });
    };
    return { app, cookie, me, handles, model, requests, newBot, send, makePremium, stop };
  }

  it("refuses a premium model a non-premium bot asks for as a sub-agent model", async () => {
    const env = await startPremiumApp("offline-fixture");
    try {
      const botId = await env.newBot(true);
      await env.send(botId, "Use a premium helper.");
      const resolveModel = env.requests[0]?.resolveModel;
      expect(resolveModel).toBeDefined();
      await expect(resolveModel!("openai-compatible", "claude-fable-fixture")).rejects.toThrow(
        PREMIUM_MODEL_REFUSAL,
      );
      // The bot's own, non-premium model still resolves for a sub-agent.
      await expect(resolveModel!("openai-compatible", "offline-fixture")).resolves.toMatchObject({
        id: "offline-fixture",
      });
    } finally {
      await env.stop();
    }
  });

  it("refuses a run whose selected model is a premium space default, until the bot is premium", async () => {
    const env = await startPremiumApp("claude-fable-fixture");
    try {
      await rpc(env.app, env.cookie, "models/setDefault", {
        provider: env.model.model.provider,
        modelId: env.model.model.id,
      });
      const botId = await env.newBot(false);
      const refused = await env.send(botId, "Answer with the default model.");
      expect(env.requests).toHaveLength(0);
      const reply = await env.handles.prisma.message.findFirst({
        where: { runId: refused, role: "bot" },
        orderBy: { seq: "desc" },
      });
      expect(JSON.stringify(reply?.blocks)).toContain(PREMIUM_MODEL_REFUSAL);
      const block = await env.handles.prisma.extAuditEvent.findFirst({
        where: { kind: "budget.block", runId: refused },
      });
      expect(block?.detail).toMatchObject({ scope: "premium", modelId: "claude-fable-fixture" });

      await env.makePremium(botId);
      await env.send(botId, "Now answer.");
      expect(env.requests.map((request) => request.model.id)).toEqual(["claude-fable-fixture"]);
    } finally {
      await env.stop();
    }
  });

  it("drops premium backup models for a non-premium bot", async () => {
    const env = await startPremiumApp("offline-fixture");
    try {
      const botId = await env.newBot(true);
      await env.handles.prisma.spaceBackupModel.createMany({
        data: [
          {
            spaceId: env.me.spaceId,
            userId: env.me.userId,
            provider: "openai-compatible",
            modelId: "claude-fable-fixture",
            position: 0,
          },
          {
            spaceId: env.me.spaceId,
            userId: env.me.userId,
            provider: "openai-compatible",
            modelId: "backup-fixture",
            position: 1,
          },
        ],
      });
      await env.send(botId, "Answer with backups.");
      expect(env.requests[0]?.fallbackModels?.map((model) => model.id)).toEqual(["backup-fixture"]);

      await env.makePremium(botId);
      await env.send(botId, "Answer again.");
      expect(env.requests[1]?.fallbackModels?.map((model) => model.id)).toEqual([
        "claude-fable-fixture",
        "backup-fixture",
      ]);
    } finally {
      await env.stop();
    }
  });
});

describeBudgets("fork extension: budgets off", () => {
  it("answers 404 and never gates a run", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-budgets-off-"));
    const { createApp } = await import("../../../apps/api/src/app.ts");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      defaultProvider: "scripted",
      defaultModel: "scripted",
      composio: new ComposioEmulator(),
      ext: { ...loadExtEnv({}), auditLog: true },
    });
    try {
      const cookie = await signup(handles.app, `budget-off-${Date.now()}@rakazo.test`, "Off");
      const me = await rpc<{ userId: string; spaceId: string }>(handles.app, cookie, "me");
      const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
        name: "Unlimited",
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, bot.id);
      for (const url of ["/api/v1/budgets/space", `/api/v1/budgets/bots/${bot.id}`]) {
        expect((await call(handles.app, cookie, "GET", url)).status).toBe(404);
      }
      expect(
        (await call(handles.app, cookie, "PUT", "/api/v1/budgets/space", { dailyUsd: 1 })).status,
      ).toBe(404);
      await handles.prisma.usageRecord.create({
        data: {
          spaceId: me.spaceId,
          userId: me.userId,
          botId: bot.id,
          provider: "fixture",
          model: "fixture",
          costUsd: 1_000,
        },
      });
      const { runId } = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
        botId: bot.id,
        text: "write a file that says unlimited",
      });
      await waitForRun(handles.prisma, runId);
      const reply = await handles.prisma.message.findFirst({
        where: { runId, role: "bot" },
        orderBy: { seq: "desc" },
      });
      expect(JSON.stringify(reply?.blocks)).not.toContain("daily budget");
      expect(
        await handles.prisma.extAuditEvent.count({
          where: { spaceId: me.spaceId, kind: { in: ["budget.block", "policy.change"] } },
        }),
      ).toBe(0);
      expect(await handles.prisma.extRunSpawn.count({ where: { parentRunId: runId } })).toBe(0);
    } finally {
      await handles.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

async function signup(app: App, email: string, name: string) {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (res.status >= 400) throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  return sessionCookieHeader(res);
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ json: body }),
  });
  const text = await res.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}

function call(app: App, cookie: string, method: string, url: string, body?: unknown) {
  return app.request(url, {
    method,
    headers: { "content-type": "application/json", cookie, origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function waitForRun(prisma: Handles["prisma"], runId: string) {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
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
