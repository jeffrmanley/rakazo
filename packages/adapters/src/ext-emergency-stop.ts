import type {
  AdapterContext,
  JobPublisher,
  SandboxProvider,
  TeamChatSendRequest,
  TeamChatSendResult,
} from "@rakazo/adapter-kit";
import { computerSleepJob, routineWakeupJob } from "@rakazo/adapter-kit";
import { ACTIVE_RUN_STATUSES, isOneShotRoutineCrons, nextCronDateAcross } from "@rakazo/core";
import type { ActiveStop, EmergencyStopReader, PrismaClient, ThreadEvents } from "@rakazo/db";
import { cancelRunsForStop, getEmergencyStop } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { cancelComputerRunWork } from "./computer-idle.js";
import { toComputerRef } from "./computer-support.js";
import type { ToolExecute } from "./ext-audit-tools.js";

/**
 * Fork extension: emergency stop enforcement in the run path. Every check is
 * deterministic code against the persisted stop state (through the installed
 * reader's short-TTL cache); with no reader installed (EXT_EMERGENCY_STOP off)
 * each helper is a no-op.
 */

/** How often a live run re-reads the stop state. With the 1 s cache, a stop lands within ~2 s. */
export const RUN_STOP_WATCH_MS = 1_000;
/** Give the halted run a moment to release its computer lease before the idle sleep checks it. */
const COMPUTER_PAUSE_DELAY_MS = 3_000;
/** Handle recorded for a team-chat reply that a stopped bot was not allowed to post. */
export const SUPPRESSED_SEND_HANDLE = "suppressed:emergency-stop";

export class EmergencyStopError extends Error {
  readonly stop: ActiveStop;

  constructor(stop: ActiveStop) {
    super("Paused by an emergency stop");
    this.name = "EmergencyStopError";
    this.stop = stop;
  }
}

export interface RunStopGuard {
  /** The stop that halted this run, once seen. */
  readonly stopped: ActiveStop | null;
  /** Read the stop state now (before a model call); a stop found here halts the run. */
  check(): Promise<ActiveStop | null>;
  /**
   * Drop tool calls once stopped. A call already executing finishes and its
   * outcome is returned (and audited by the wrapped executor); the run halts
   * right after it, so nothing new starts.
   */
  wrapTool(execute: ToolExecute): ToolExecute;
  dispose(): void;
}

/**
 * One guard per live run: checks before the model call and around every tool
 * call, and watches the stop state so an in-flight model call is aborted
 * within one interval of the stop becoming visible.
 */
export function createRunStopGuard(options: {
  reader: EmergencyStopReader | null;
  target: { spaceId: string; botId: string };
  /** Halt the run: abort the model call and cancel the run row. Called at most once. */
  onStop: (stop: ActiveStop) => void;
  intervalMs?: number;
}): RunStopGuard {
  const { reader, target, onStop } = options;
  if (!reader) {
    return {
      stopped: null,
      check: async () => null,
      wrapTool: (execute) => execute,
      dispose: () => undefined,
    };
  }
  let stopped: ActiveStop | null = null;
  let fired = false;
  let toolsInFlight = 0;
  const fire = () => {
    if (fired || !stopped || toolsInFlight > 0) return;
    fired = true;
    onStop(stopped);
  };
  const observe = (stop: ActiveStop | null) => {
    if (!stop) return;
    stopped ??= stop;
    fire();
  };
  const check = async () => {
    if (stopped) return stopped;
    observe(await reader.check(target));
    return stopped;
  };
  const timer = setInterval(() => {
    if (fired) return;
    reader
      .check(target)
      .then(observe)
      .catch((error) => getLogger().warn("emergency stop check failed", { error }));
  }, options.intervalMs ?? RUN_STOP_WATCH_MS);
  timer.unref?.();
  return {
    get stopped() {
      return stopped;
    },
    check,
    wrapTool: (execute) => async (name, args, executionId, route, observer) => {
      const before = await check();
      if (before) throw new EmergencyStopError(before);
      toolsInFlight += 1;
      try {
        return await execute(name, args, executionId, route, observer);
      } finally {
        toolsInFlight -= 1;
        fire();
        // Re-read before the result goes back to the model, so the next model call never starts.
        await check().catch(() => undefined);
      }
    },
    dispose: () => clearInterval(timer),
  };
}

/**
 * Cancel one halted run, announce it, and pause its computer. Called once the
 * run has no tool call in flight, so only work the run left in the background
 * is terminated.
 */
export async function cancelStoppedRun(
  deps: {
    prisma: PrismaClient;
    events: Pick<ThreadEvents, "notify">;
    jobs?: Pick<JobPublisher, "enqueue">;
    sandbox?: Pick<SandboxProvider, "execute">;
  },
  run: { id: string; computerId?: string | null },
): Promise<void> {
  const cancelled = await cancelRunsForStop(deps.prisma, {
    runIds: [run.id],
    statuses: ACTIVE_RUN_STATUSES,
  });
  await notifyStoppedThreads(deps.events, cancelled.threads);
  if (!run.computerId || !deps.jobs || !deps.sandbox) return;
  const computer = await deps.prisma.computer.findUnique({
    where: { id: run.computerId },
    select: COMPUTER_SELECT,
  });
  if (computer?.providerRef) {
    await pauseComputer({ sandbox: deps.sandbox, jobs: deps.jobs }, computer, [run.id]);
  }
}

/** Run start: a run of a stopped bot is cancelled before it is leased. Returns true when halted. */
export async function haltRunIfStopped(
  deps: { prisma: PrismaClient; events: Pick<ThreadEvents, "notify"> },
  run: { id: string; spaceId: string; botId: string },
): Promise<boolean> {
  const reader = getEmergencyStop();
  if (!reader) return false;
  const stop = await reader.check({ spaceId: run.spaceId, botId: run.botId });
  if (!stop) return false;
  await cancelStoppedRun(deps, run);
  return true;
}

/**
 * Scheduled routines of a stopped bot do not start. A recurring routine skips
 * this occurrence; a one-shot routine stays due and fires once resumed (the
 * reconciler re-arms due routines). Returns true when the wake was held back.
 */
export async function holdRoutineIfStopped(
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  routine: {
    id: string;
    spaceId: string;
    botId: string;
    crons: string[];
    timezone: string;
  },
  scheduledAt: Date,
): Promise<boolean> {
  const reader = getEmergencyStop();
  if (!reader) return false;
  if (!(await reader.check({ spaceId: routine.spaceId, botId: routine.botId }))) return false;
  if (isOneShotRoutineCrons(routine.crons)) return true;
  const nextRunAt = nextCronDateAcross(
    routine.crons,
    new Date(Math.max(Date.now(), scheduledAt.getTime())),
    routine.timezone,
  );
  const moved = await deps.prisma.routine.updateMany({
    where: { id: routine.id, active: true, nextRunAt: scheduledAt },
    data: { nextRunAt },
  });
  if (moved.count === 1 && nextRunAt)
    await deps.jobs.enqueue(routineWakeupJob(routine.id, nextRunAt));
  return true;
}

/** True while an active stop covers this bot: no inbound run, no outbound send. */
export async function isBotStopped(target: { spaceId: string; botId: string }): Promise<boolean> {
  const reader = getEmergencyStop();
  if (!reader) return false;
  return Boolean(await reader.check(target));
}

/**
 * Team-chat replies of a stopped bot are dropped, not deferred: the bridge
 * records the suppressed handle and never posts the reply after a resume.
 */
export function guardTeamChatSend(
  send: (request: TeamChatSendRequest) => Promise<TeamChatSendResult>,
  options: {
    reader: EmergencyStopReader | null;
    bot: () => Promise<{ spaceId: string; botId: string } | null>;
  },
): (request: TeamChatSendRequest) => Promise<TeamChatSendResult> {
  const { reader } = options;
  if (!reader) return send;
  return async (request) => {
    const bot = await options.bot();
    if (bot && (await reader.check(bot))) return { handle: SUPPRESSED_SEND_HANDLE };
    return send(request);
  };
}

const COMPUTER_SELECT = {
  id: true,
  spaceId: true,
  userId: true,
  homeKey: true,
  kind: true,
  providerRef: true,
} as const;

type PausableComputer = {
  id: string;
  spaceId: string;
  userId: string;
  homeKey: string;
  kind: string;
  providerRef: string | null;
};

/**
 * Pause, not destroy: terminate the background work these runs left on the
 * computer, then let the regular idle sleep checkpoint the workspace and stop
 * the sandbox once no run holds it (a computer another running bot uses stays up).
 */
async function pauseComputer(
  deps: { sandbox: Pick<SandboxProvider, "execute">; jobs: Pick<JobPublisher, "enqueue"> },
  computer: PausableComputer,
  runIds: readonly string[],
): Promise<void> {
  const context: AdapterContext = {
    operationId: "emergency-stop",
    traceId: "emergency-stop",
    spaceId: computer.spaceId,
    userId: computer.userId,
    signal: AbortSignal.timeout(20_000),
  };
  for (const runId of runIds) {
    await cancelComputerRunWork(deps.sandbox, toComputerRef(computer), computer.id, runId, {
      ...context,
      runId,
    });
  }
  await deps.jobs
    .enqueue(computerSleepJob(computer.id, new Date(Date.now() + COMPUTER_PAUSE_DELAY_MS)))
    .catch((error) => getLogger().error("emergency stop computer pause enqueue", error));
}

/**
 * Pause the running computers of a stopped scope. `runIds` are runs the stop
 * cancelled before they were executing; a running run is paused by its own
 * worker once its in-flight tool call has finished (cancelStoppedRun).
 */
export async function pauseStoppedComputers(
  deps: {
    prisma: PrismaClient;
    sandbox: Pick<SandboxProvider, "execute">;
    jobs: Pick<JobPublisher, "enqueue">;
  },
  target: { scope: "bot" | "space" | "global"; spaceId: string | null; botId: string | null },
  runIds: readonly string[],
): Promise<void> {
  const computers = await deps.prisma.computer.findMany({
    where: {
      state: "running",
      providerRef: { not: null },
      ...(target.scope === "bot"
        ? { bots: { some: { id: target.botId ?? "" } } }
        : target.scope === "space"
          ? { spaceId: target.spaceId ?? "" }
          : {}),
    },
    select: COMPUTER_SELECT,
  });
  if (computers.length === 0) return;
  const runs = runIds.length
    ? await deps.prisma.run.findMany({
        where: { id: { in: [...runIds] } },
        select: { id: true, bot: { select: { computerId: true } } },
      })
    : [];
  await Promise.all(
    computers.map((computer) =>
      pauseComputer(
        deps,
        computer,
        runs.filter((run) => run.bot.computerId === computer.id).map((run) => run.id),
      ),
    ),
  );
}

/** Realtime wake for threads whose runs a stop cancelled; the events themselves are durable. */
export async function notifyStoppedThreads(
  events: Pick<ThreadEvents, "notify">,
  threads: Array<{ threadId: string; seq: number }>,
): Promise<void> {
  await Promise.all(
    threads.map(({ threadId, seq }) =>
      events.notify(threadId, seq).catch((error) => {
        // Subscribers catch up from the durable event cursor after a missed wake.
        getLogger().error("emergency stop realtime notification", error);
      }),
    ),
  );
}
