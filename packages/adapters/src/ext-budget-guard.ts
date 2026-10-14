/**
 * Fork extension (EXT_BUDGETS): where spend caps, run concurrency and delegation
 * limits are enforced in the worker. The executor calls exactly four hooks:
 *
 * - `claimRunWithinBotLimit` at run claim (concurrency: over the cap, the run stays queued);
 * - `refuseRunOverBudget` right after the claim (over a daily cap, the run is refused);
 * - `budgetAfterModelCall` after each priced model call (halt before the next one);
 * - `delegationLimiter` at every delegation tool call.
 *
 * Routines use `skipRoutineOverBudget` when they fire. With the policy not installed
 * (flag off) every hook is a pass-through that touches nothing.
 */
import type { BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import { messagingDeliverJob, routineWakeupJob, runContinueJob } from "@rakazo/adapter-kit";
import type { BudgetDefaults, BudgetNoticeKind } from "@rakazo/core";
import {
  BUDGET_BLOCK_TEXT,
  BUDGET_MONTHLY_SPACE_ALERT_USD,
  BUDGET_SPACE_BLOCK_TEXT,
  BUDGET_STOP_TEXT,
  budgetNoticeKey,
  formatUsd,
  isBackgroundRunTrigger,
  isPremiumModelId,
  PREMIUM_MODEL_REFUSAL,
  resolveBotLimits,
} from "@rakazo/core";
import type { BudgetStatus, Prisma, PrismaClient, ThreadEvents } from "@rakazo/db";
import {
  admitRunSpawn,
  appendEventInTransaction,
  claimBotRunSlot,
  claimBudgetNotice,
  createThreadMessageInTransaction,
  getAuditWriter,
  homeMessagingIdentity,
  loadBotBudget,
  loadBudgetStatus,
  monthSpendUsd,
  recordRunSpawn,
  releaseBudgetNotice,
  runSpawnDepth,
  spaceOwnerUserId,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { returnBotMessageOutcome } from "./bot-messages.js";
import type { ToolExecute } from "./ext-audit-tools.js";

let installed: BudgetDefaults | null = null;

/** EXT_BUDGETS=1 installs the deployment defaults; null turns every hook into a pass-through. */
export function installBudgetPolicy(defaults: BudgetDefaults | null): void {
  installed = defaults;
}

export function getBudgetPolicy(): BudgetDefaults | null {
  return installed;
}

/** How long a run over its bot's concurrency cap waits before trying to claim again. */
export const QUEUED_RUN_RETRY_MS = 2_000;

type GuardDeps = {
  prisma: PrismaClient;
  jobs: JobPublisher;
};

type RunRef = {
  id: string;
  spaceId: string;
  botId: string;
  userId: string;
  threadId: string;
  trigger: string;
  modelId?: string | null;
};

/**
 * Concurrency hook at run claim. Returns null when the bot already has its
 * maximum of runs leased or running: the run stays queued and retries shortly.
 */
export async function claimRunWithinBotLimit<T>(
  deps: GuardDeps,
  run: Pick<RunRef, "id" | "spaceId" | "botId">,
  claim: (db: Pick<Prisma.TransactionClient, "run">) => Promise<T>,
): Promise<T | null> {
  const policy = installed;
  if (!policy) return claim(deps.prisma);
  const limits = resolveBotLimits(
    await loadBotBudget(deps.prisma, { spaceId: run.spaceId, botId: run.botId }),
    policy,
  );
  const slot = await claimBotRunSlot(
    deps.prisma,
    { botId: run.botId, runId: run.id, maxConcurrentRuns: limits.maxConcurrentRuns },
    claim,
  );
  if (!slot.queued) return slot.result;
  await deps.jobs.enqueue(delayed(runContinueJob(run.id), QUEUED_RUN_RETRY_MS));
  return null;
}

function delayed(job: BackgroundJob, ms: number): BackgroundJob {
  return { ...job, availableAt: new Date(Date.now() + ms) };
}

export type BudgetBlock = {
  scope: "bot" | "space" | "premium";
  text: string;
  detail: Record<string, unknown>;
};

/** The reason a new run of this bot may not start now, or null. */
export async function budgetBlockFor(
  prisma: PrismaClient,
  run: Pick<RunRef, "spaceId" | "botId">,
  now = new Date(),
): Promise<BudgetBlock | null> {
  const policy = installed;
  if (!policy) return null;
  const status = await loadBudgetStatus(prisma, {
    spaceId: run.spaceId,
    botId: run.botId,
    now,
    defaults: policy,
  });
  return blockFromStatus(status);
}

function blockFromStatus(status: BudgetStatus): BudgetBlock | null {
  if (status.space.level === "blocked") {
    return {
      scope: "space",
      text: BUDGET_SPACE_BLOCK_TEXT,
      detail: {
        scope: "space",
        day: status.day,
        spentUsd: status.space.spentUsd,
        capUsd: status.space.capUsd,
      },
    };
  }
  if (status.bot.level === "blocked") {
    return {
      scope: "bot",
      text: BUDGET_BLOCK_TEXT,
      detail: {
        scope: "bot",
        day: status.day,
        spentUsd: status.bot.spentUsd,
        capUsd: status.bot.capUsd,
      },
    };
  }
  return null;
}

/**
 * Budget hook right after the claim. Over a daily cap (bot or space) the run does not
 * start: a `budget.block` event is recorded first (fail closed), then the run finishes
 * with a short notice the requester sees in chat. Returns true when refused.
 */
export async function refuseRunOverBudget(
  deps: GuardDeps & { events: ThreadEvents },
  input: RefuseInput,
): Promise<boolean> {
  if (!installed) return false;
  const block = await budgetBlockFor(deps.prisma, input.run);
  if (!block) return false;
  await refuseRun(deps, input, block);
  return true;
}

type RefuseInput = {
  run: RunRef & { taskId: string; sourceMessageId?: string | null };
  workerId: string;
  fence: number;
  attemptId: string;
};

/**
 * Premium hook, once the run's model is selected (bot, connection, space or deployment
 * default): a Fable or Mythos class model on a non-premium bot refuses the run with the
 * premium notice. `allows` also filters backups and sub-agent models for the run.
 */
export async function premiumModelGate(
  prisma: PrismaClient,
  run: Pick<RunRef, "spaceId" | "botId">,
): Promise<{ allows: (modelId: string | null | undefined) => boolean }> {
  const premium =
    !installed || (await loadBotBudget(prisma, { spaceId: run.spaceId, botId: run.botId })).premium;
  return { allows: (modelId) => premium || !isPremiumModelId(modelId) };
}

/** Refuses a run whose selected model the bot may not use. */
export async function refuseRunForModel(
  deps: GuardDeps & { events: ThreadEvents },
  input: RefuseInput & { modelId: string },
): Promise<void> {
  await refuseRun(deps, input, {
    scope: "premium",
    text: PREMIUM_MODEL_REFUSAL,
    detail: { scope: "premium", modelId: input.modelId },
  });
}

/** Records the block first (fail closed), then finishes the run with its notice. */
async function refuseRun(
  deps: GuardDeps & { events: ThreadEvents },
  input: RefuseInput,
  block: BudgetBlock,
): Promise<void> {
  const { run } = input;
  const bot = await deps.prisma.bot.findUniqueOrThrow({
    where: { id: run.botId },
    select: { name: true },
  });
  await recordBudgetBlock({
    spaceId: run.spaceId,
    botId: run.botId,
    runId: run.id,
    summary: `Run refused: ${block.scope === "premium" ? "premium model on a non-premium bot" : `${block.scope} daily budget reached`}`,
    detail: { ...block.detail, trigger: run.trigger },
  });
  const finished = await deps.events.finalizeRun({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId: run.id,
    taskId: run.taskId,
    attemptId: input.attemptId,
    leaseOwner: input.workerId,
    leaseFence: input.fence,
    outcome: "completed",
    blocks: isBackgroundRunTrigger(run.trigger) ? [] : [{ kind: "text", text: block.text }],
    markUnread: true,
  });
  if (finished) await afterBudgetFinish(deps, run, bot.name, block.text, finished);
}

async function afterBudgetFinish(
  deps: GuardDeps & { events: ThreadEvents },
  run: RunRef & { sourceMessageId?: string | null },
  botName: string,
  text: string,
  finished: { continuationRunId: string | null },
) {
  if (finished.continuationRunId) {
    await deps.jobs
      .enqueue(runContinueJob(finished.continuationRunId))
      .catch((error) => getLogger().error("steering continuation enqueue", error));
  }
  if (run.trigger === "bot_message") {
    await returnBotMessageOutcome(deps, run, { id: run.botId, name: botName }, text, "status", {
      forceUnread: true,
    }).catch((error) => getLogger().error("bot message budget return", error));
  }
}

async function recordBudgetBlock(input: {
  spaceId: string;
  botId: string;
  runId?: string;
  summary: string;
  detail: Record<string, unknown>;
  tx?: Prisma.TransactionClient;
}) {
  const audit = getAuditWriter();
  if (!audit) {
    getLogger().info("budget block", {
      spaceId: input.spaceId,
      botId: input.botId,
      ...input.detail,
    });
    return;
  }
  const event = {
    spaceId: input.spaceId,
    botId: input.botId,
    runId: input.runId ?? null,
    actor: { type: "system" as const, id: "budgets" },
    kind: "budget.block" as const,
    summary: input.summary,
    detail: input.detail,
  };
  if (input.tx) await audit.recordInTransaction(input.tx, event);
  else await audit.record(event);
}

/**
 * Model-call hook: after a priced call is recorded. Sends any threshold notices and
 * returns true when the run must halt (the call that just finished is kept).
 */
export async function budgetAfterModelCall(
  deps: GuardDeps & { events: ThreadEvents },
  run: Pick<RunRef, "spaceId" | "botId">,
  now = new Date(),
): Promise<boolean> {
  const policy = installed;
  if (!policy) return false;
  const status = await loadBudgetStatus(deps.prisma, {
    spaceId: run.spaceId,
    botId: run.botId,
    now,
    defaults: policy,
  });
  await sendThresholdNotices(deps, run, status, now).catch((error) =>
    getLogger().error("budget notice failed", error),
  );
  return status.bot.level === "blocked" || status.space.level === "blocked";
}

/**
 * Finishes a run halted by `budgetAfterModelCall`: the model call that crossed the cap
 * is kept, nothing further runs, and the run completes with a short stop notice.
 */
export async function haltRunForBudget(
  deps: GuardDeps & { events: ThreadEvents },
  input: {
    run: RunRef & { taskId: string; sourceMessageId?: string | null };
    botName: string;
    workerId: string;
    fence: number;
    attemptId: string;
  },
): Promise<void> {
  const { run } = input;
  await recordBudgetBlock({
    spaceId: run.spaceId,
    botId: run.botId,
    runId: run.id,
    summary: "Run stopped: daily budget reached",
    detail: { reason: "halted", trigger: run.trigger },
  }).catch((error) => getLogger().error("budget halt audit failed", error));
  const finished = await deps.events.finalizeRun({
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    runId: run.id,
    taskId: run.taskId,
    attemptId: input.attemptId,
    leaseOwner: input.workerId,
    leaseFence: input.fence,
    outcome: "completed",
    blocks: isBackgroundRunTrigger(run.trigger) ? [] : [{ kind: "text", text: BUDGET_STOP_TEXT }],
    markUnread: true,
  });
  if (finished) await afterBudgetFinish(deps, run, input.botName, BUDGET_STOP_TEXT, finished);
}

/** Marks a halt requested by `budgetAfterModelCall`, so the executor can tell it from a failure. */
export class BudgetStop extends Error {
  constructor() {
    super(BUDGET_STOP_TEXT);
    this.name = "BudgetStop";
  }
}

async function sendThresholdNotices(
  deps: GuardDeps & { events: ThreadEvents },
  run: Pick<RunRef, "spaceId" | "botId">,
  status: BudgetStatus,
  now: Date,
) {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: run.botId, spaceId: run.spaceId },
    select: { id: true, name: true, userId: true },
  });
  if (!bot) return;
  if (status.bot.level !== "ok") {
    const recipient = await botOwnerOrSpaceOwner(deps.prisma, run.spaceId, bot.userId);
    await notifyOnce(deps, {
      spaceId: run.spaceId,
      key: budgetNoticeKey("bot.warn", bot.id, now),
      recipient,
      preferBotId: bot.id,
      text: `${bot.name} has used ${formatUsd(status.bot.spentUsd)} of its ${formatUsd(status.bot.capUsd)} daily budget.`,
    });
  }
  if (status.space.level !== "ok") {
    await notifyOnce(deps, {
      spaceId: run.spaceId,
      key: budgetNoticeKey("space.warn", run.spaceId, now),
      recipient: await spaceOwnerUserId(deps.prisma, run.spaceId),
      preferBotId: bot.id,
      text: `This space has used ${formatUsd(status.space.spentUsd)} of its ${formatUsd(status.space.capUsd)} daily budget.`,
    });
  }
  const month = await monthSpendUsd(deps.prisma, { spaceId: run.spaceId, now });
  if (month >= BUDGET_MONTHLY_SPACE_ALERT_USD) {
    await notifyOnce(deps, {
      spaceId: run.spaceId,
      key: budgetNoticeKey("space.month", run.spaceId, now),
      recipient: await spaceOwnerUserId(deps.prisma, run.spaceId),
      preferBotId: bot.id,
      text: `This space has spent ${formatUsd(month)} this month.`,
    });
  }
}

async function botOwnerOrSpaceOwner(
  prisma: PrismaClient,
  spaceId: string,
  ownerId: string,
): Promise<string | null> {
  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId, userId: ownerId } },
    select: { id: true },
  });
  return member ? ownerId : spaceOwnerUserId(prisma, spaceId);
}

async function notifyOnce(
  deps: GuardDeps & { events: ThreadEvents },
  input: {
    spaceId: string;
    key: { kind: BudgetNoticeKind; subjectId: string; period: string };
    recipient: string | null;
    preferBotId: string;
    text: string;
  },
) {
  if (!input.recipient) return;
  if (!(await claimBudgetNotice(deps.prisma, { spaceId: input.spaceId, ...input.key }))) return;
  try {
    const delivered = await notifyUser(deps, {
      spaceId: input.spaceId,
      userId: input.recipient,
      preferBotId: input.preferBotId,
      text: input.text,
      idempotencyKey: `ext-budget:${input.key.kind}:${input.key.subjectId}:${input.key.period}`,
    });
    if (!delivered) await releaseBudgetNotice(deps.prisma, input.key);
  } catch (error) {
    await releaseBudgetNotice(deps.prisma, input.key).catch(() => undefined);
    throw error;
  }
}

/**
 * A proactive notice to one person: in chat through a bot's home messaging identity when
 * one of their bots in the space has one linked, else in-app as an unread note in their
 * bot's thread. Returns false when the person has no bot in the space to reach them by.
 */
export async function notifyUser(
  deps: GuardDeps & { events: ThreadEvents },
  input: {
    spaceId: string;
    userId: string;
    preferBotId: string;
    text: string;
    idempotencyKey: string;
  },
): Promise<"chat" | "in_app" | false> {
  const bots = await deps.prisma.bot.findMany({
    where: { spaceId: input.spaceId, userId: input.userId, archivedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, thread: { select: { id: true } } },
  });
  bots.sort((a, b) => Number(b.id === input.preferBotId) - Number(a.id === input.preferBotId));
  for (const bot of bots) {
    const identity = await homeMessagingIdentity(deps.prisma, bot.id);
    if (!identity) continue;
    await deps.prisma.messagingOutbound.createMany({
      data: [
        {
          idempotencyKey: input.idempotencyKey,
          kind: "dm",
          identityId: identity.id,
          body: input.text,
        },
      ],
      skipDuplicates: true,
    });
    await deps.jobs.enqueue(messagingDeliverJob());
    return "chat";
  }
  const target = bots.find((bot) => bot.thread);
  if (!target?.thread) return false;
  const threadId = target.thread.id;
  const event = await deps.prisma.$transaction(async (tx) => {
    const message = await createThreadMessageInTransaction(tx, {
      threadId,
      role: "system",
      blocks: [{ kind: "meta", text: input.text }],
      botId: target.id,
      markUnread: true,
    });
    return appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId,
      botId: target.id,
      type: "thread.message.created",
      payload: {
        messageId: message.id,
        role: "system",
        blocks: [{ kind: "meta", text: input.text }],
      },
    });
  });
  await deps.events.notify(threadId, event.seq).catch(() => undefined);
  return "in_app";
}

/** Tools that hand work to another run, bot or agent. */
export const DELEGATION_TOOLS = new Set([
  "message_bot",
  "spawn_bot",
  "handoff_to_bot",
  "run_subagent",
  "cloud_agent_launch",
]);

/** Delegations that run inside this run or outside the product: recorded at admission. */
const IN_RUN_DELEGATIONS = new Set(["run_subagent", "cloud_agent_launch"]);

/**
 * Delegation hook. Checks depth and fan-out for one delegation of `run`; refusals are
 * returned as text for the model. In-run delegations are counted here; delegations that
 * create a run are counted where that run is created (`recordDelegatedRun`).
 */
export async function admitDelegation(
  prisma: PrismaClient,
  run: Pick<RunRef, "id" | "spaceId" | "botId">,
  tool: string,
): Promise<string | null> {
  const policy = installed;
  if (!policy || !DELEGATION_TOOLS.has(tool)) return null;
  const settings = await loadBotBudget(prisma, { spaceId: run.spaceId, botId: run.botId });
  const check = await admitRunSpawn(prisma, {
    spaceId: run.spaceId,
    parentRunId: run.id,
    tool,
    limits: resolveBotLimits(settings, policy),
    record: IN_RUN_DELEGATIONS.has(tool),
  });
  return check.ok ? null : check.error;
}

/**
 * One run's delegation gate. `wrap` guards the executor's tool function: delegation tools
 * pass `admitDelegation` first, and after a budget halt every tool is refused. `admit` is
 * the same check for delegations the runtime performs itself (run_subagent). Both share
 * one queue, so a run's delegations are admitted one at a time and a check followed by
 * the run it creates cannot interleave with another delegation. A refusal is an ordinary
 * tool error the model sees.
 */
export function delegationLimiter(
  prisma: PrismaClient,
  run: Pick<RunRef, "id" | "spaceId" | "botId">,
  halted: () => boolean = () => false,
): {
  wrap: (execute: ToolExecute) => ToolExecute;
  admit: (tool: string) => Promise<string | null>;
} {
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const turn = queue.then(work);
    queue = turn.catch(() => undefined);
    return turn;
  };
  return {
    admit: (tool) =>
      installed ? serialize(() => admitDelegation(prisma, run, tool)) : Promise.resolve(null),
    wrap: (execute) => {
      if (!installed) return execute;
      return async (name, args, executionId, route, observer) => {
        if (halted()) return { error: BUDGET_STOP_TEXT };
        if (!DELEGATION_TOOLS.has(name)) return execute(name, args, executionId, route, observer);
        return serialize(async () => {
          const refusal = await admitDelegation(prisma, run, name);
          if (refusal) return { error: refusal };
          return execute(name, args, executionId, route, observer);
        });
      };
    },
  };
}

/**
 * Records a run created by a delegation, inside the transaction that creates it, so the
 * child's depth is known before it can be claimed. No-op with the flag off.
 */
export async function recordDelegatedRun(
  tx: Prisma.TransactionClient,
  input: { spaceId: string; parentRunId: string; childRunId: string; tool: string },
): Promise<void> {
  if (!installed) return;
  const depth = (await runSpawnDepth(tx, input.parentRunId)) + 1;
  await recordRunSpawn(tx, { ...input, depth });
}

/**
 * Routine hook. A routine whose bot or space is over its daily cap does not fire: the
 * schedule advances to the next occurrence (no retry) and the skip is recorded as a
 * `budget.block` event. Returns true when skipped.
 */
export async function skipRoutineOverBudget(
  deps: GuardDeps,
  input: {
    routine: { id: string; spaceId: string; crons: string[] };
    botId: string;
    scheduledAt: Date;
    nextRunAt: Date | null;
  },
): Promise<boolean> {
  if (!installed) return false;
  const block = await budgetBlockFor(deps.prisma, {
    spaceId: input.routine.spaceId,
    botId: input.botId,
  });
  if (!block) return false;
  const skipped = await deps.prisma.$transaction(async (tx) => {
    const updated = await tx.routine.updateMany({
      where: {
        id: input.routine.id,
        active: true,
        nextRunAt: input.scheduledAt,
      },
      data: { nextRunAt: input.nextRunAt, ...(input.nextRunAt ? {} : { active: false }) },
    });
    if (updated.count !== 1) return false;
    await recordBudgetBlock({
      tx,
      spaceId: input.routine.spaceId,
      botId: input.botId,
      summary: "Routine skipped: daily budget reached",
      detail: {
        ...block.detail,
        reason: "routine_skipped",
        routineId: input.routine.id,
        scheduledFor: input.scheduledAt.toISOString(),
      },
    });
    return true;
  });
  if (skipped && input.nextRunAt) {
    await deps.jobs.enqueue(routineWakeupJob(input.routine.id, input.nextRunAt));
  }
  return true;
}
