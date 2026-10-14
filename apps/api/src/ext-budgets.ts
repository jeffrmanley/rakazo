import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { getBudgetPolicy } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { BudgetDefaults, Parsed } from "@rakazo/core";
import {
  BUDGET_MAX_DAILY_USD,
  BUDGET_PROFILES,
  isBudgetProfile,
  isPremiumModelId,
  PREMIUM_MODEL_REFUSAL,
  parseBudgetAmount,
  parseLimit,
  resolveBotLimits,
} from "@rakazo/core";
import type { BotBudgetPatch, Prisma, PrismaClient } from "@rakazo/db";
import {
  addBudgetTopUp,
  getAuditWriter,
  isSpaceOwner,
  loadBotBudget,
  loadBudgetStatus,
  loadSpaceBudgetStatus,
  saveBotBudget,
  saveSpaceBudget,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Context, Hono } from "hono";

export const BUDGETS_API_PATH = "/api/v1/budgets";

type Deps = {
  prisma: PrismaClient;
  defaults: BudgetDefaults;
  authenticate: (request: Request) => Promise<Actor | null>;
  now?: () => Date;
};

class HttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Budget settings, today's spend and top-ups (EXT_BUDGETS). Mounted only with the flag on,
 * so every path answers 404 when it is off. The space is always the authenticated actor's;
 * a spaceId in the query or body is ignored. Changes are audited as `policy.change` in the
 * same transaction (fail closed).
 *
 * - `GET  /api/v1/budgets/space`            today's space spend and cap
 * - `PUT  /api/v1/budgets/space`            `{ dailyUsd: number | null }` (space owner)
 * - `POST /api/v1/budgets/space/top-up`     `{ amountUsd }` (space owner)
 * - `GET  /api/v1/budgets/bots/:botId`      the bot's settings, limits and today's spend
 * - `PUT  /api/v1/budgets/bots/:botId`      profile, custom amount, limits; premium (space owner)
 * - `POST /api/v1/budgets/bots/:botId/top-up` `{ amountUsd }` (space owner)
 */
export function mountBudgetRoutes(app: Hono, deps: Deps): void {
  const now = deps.now ?? (() => new Date());
  const route =
    (handler: (c: Context, actor: Actor) => Promise<Response>) => async (c: Context) => {
      const actor = await deps.authenticate(c.req.raw);
      if (!actor) return c.json({ error: "Unauthorized" }, 401);
      c.header("cache-control", "no-store");
      try {
        return await handler(c, actor);
      } catch (error) {
        if (error instanceof HttpError) {
          if (error.status === 403 || error.status === 404) {
            getLogger().warn("budget request denied", {
              "user.id": actor.userId,
              "space.id": actor.spaceId,
              path: c.req.path,
              status: error.status,
            });
          }
          return c.json({ error: error.message }, error.status);
        }
        const errorId = randomUUID();
        getLogger().error("budget request failed", error, { "error.id": errorId });
        return c.json({ error: "Internal error", error_id: errorId }, 500);
      }
    };

  app.get(
    `${BUDGETS_API_PATH}/space`,
    route(async (c, actor) => {
      const owner = await isSpaceOwner(deps.prisma, actor);
      const status = await loadSpaceBudgetStatus(deps.prisma, {
        spaceId: actor.spaceId,
        now: now(),
        defaults: deps.defaults,
      });
      return c.json({ ...status, canManage: owner, maxUsd: BUDGET_MAX_DAILY_USD });
    }),
  );

  app.put(
    `${BUDGETS_API_PATH}/space`,
    route(async (c, actor) => {
      await requireSpaceOwner(deps.prisma, actor);
      const body = await readBody(c);
      const dailyUsd = body.dailyUsd === null ? null : unwrap(parseBudgetAmount(body.dailyUsd));
      await deps.prisma.$transaction(async (tx) => {
        await saveSpaceBudget(tx, { spaceId: actor.spaceId, actorId: actor.userId, dailyUsd });
        await recordPolicyChange(tx, actor, {
          summary: "Space daily budget changed",
          detail: { target: "space", dailyUsd },
        });
      });
      return c.json(
        await loadSpaceBudgetStatus(deps.prisma, {
          spaceId: actor.spaceId,
          now: now(),
          defaults: deps.defaults,
        }),
      );
    }),
  );

  app.post(
    `${BUDGETS_API_PATH}/space/top-up`,
    route(async (c, actor) => {
      await requireSpaceOwner(deps.prisma, actor);
      const amountUsd = unwrap(parseBudgetAmount((await readBody(c)).amountUsd));
      const topUp = await deps.prisma.$transaction(async (tx) => {
        const created = await addBudgetTopUp(tx, {
          spaceId: actor.spaceId,
          botId: null,
          amountUsd,
          actorId: actor.userId,
          now: now(),
        });
        await recordPolicyChange(tx, actor, {
          summary: "Space budget topped up for today",
          detail: { target: "space", amountUsd, day: created.day, expiresAt: created.expiresAt },
        });
        return created;
      });
      return c.json({ ...topUp, amountUsd }, 201);
    }),
  );

  app.get(
    `${BUDGETS_API_PATH}/bots/:botId`,
    route(async (c, actor) => {
      const access = await botAccess(deps.prisma, actor, c.req.param("botId") ?? "");
      return c.json(await botView(deps, access, now()));
    }),
  );

  app.put(
    `${BUDGETS_API_PATH}/bots/:botId`,
    route(async (c, actor) => {
      const access = await botAccess(deps.prisma, actor, c.req.param("botId") ?? "");
      const patch = parseBotPatch(await readBody(c));
      if (patch.premium !== undefined && !access.spaceOwner) {
        throw new HttpError(403, "Only a space owner can change premium");
      }
      if (patch.profile === "custom" && patch.customDailyUsd === undefined) {
        const current = await loadBotBudget(deps.prisma, {
          spaceId: actor.spaceId,
          botId: access.botId,
        });
        if (current.customDailyUsd === null) {
          throw new HttpError(400, "A custom budget needs an amount");
        }
      }
      await deps.prisma.$transaction(async (tx) => {
        const before = await loadBotBudget(tx, { spaceId: actor.spaceId, botId: access.botId });
        const after = await saveBotBudget(tx, {
          spaceId: actor.spaceId,
          botId: access.botId,
          actorId: actor.userId,
          patch,
        });
        await recordPolicyChange(tx, actor, {
          botId: access.botId,
          summary: "Bot budget settings changed",
          detail: { target: "bot", botId: access.botId, before, after },
        });
      });
      return c.json(await botView(deps, access, now()));
    }),
  );

  app.post(
    `${BUDGETS_API_PATH}/bots/:botId/top-up`,
    route(async (c, actor) => {
      const access = await botAccess(deps.prisma, actor, c.req.param("botId") ?? "");
      if (!access.spaceOwner) throw new HttpError(403, "Only a space owner can top up");
      const amountUsd = unwrap(parseBudgetAmount((await readBody(c)).amountUsd));
      const topUp = await deps.prisma.$transaction(async (tx) => {
        const created = await addBudgetTopUp(tx, {
          spaceId: actor.spaceId,
          botId: access.botId,
          amountUsd,
          actorId: actor.userId,
          now: now(),
        });
        await recordPolicyChange(tx, actor, {
          botId: access.botId,
          summary: "Bot budget topped up for today",
          detail: {
            target: "bot",
            botId: access.botId,
            amountUsd,
            day: created.day,
            expiresAt: created.expiresAt,
          },
        });
        return created;
      });
      return c.json({ ...topUp, amountUsd }, 201);
    }),
  );
}

type BotAccess = { botId: string; spaceId: string; spaceOwner: boolean };

/**
 * The bot's owner and the space owner may read and edit a bot's budget. A bot in another
 * space, or one the caller may not see, answers 404 exactly like a missing one.
 */
async function botAccess(prisma: PrismaClient, actor: Actor, botId: string): Promise<BotAccess> {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, archivedAt: null },
    select: { id: true, userId: true },
  });
  if (!bot) throw new HttpError(404, "Not found");
  const spaceOwner = await isSpaceOwner(prisma, actor);
  if (bot.userId !== actor.userId && !spaceOwner) throw new HttpError(404, "Not found");
  return { botId: bot.id, spaceId: actor.spaceId, spaceOwner };
}

async function botView(deps: Deps, access: BotAccess, now: Date) {
  const status = await loadBudgetStatus(deps.prisma, {
    spaceId: access.spaceId,
    botId: access.botId,
    now,
    defaults: deps.defaults,
  });
  return {
    day: status.day,
    resetsAt: status.resetsAt,
    bot: status.bot,
    space: status.space,
    settings: status.settings,
    limits: resolveBotLimits(status.settings, deps.defaults),
    defaults: {
      assistantDailyUsd: deps.defaults.budgetDefaultDailyUsd,
      maxConcurrentRuns: deps.defaults.maxConcurrentRunsPerBot,
      maxSpawnDepth: deps.defaults.maxSpawnDepth,
      maxSpawnFanout: deps.defaults.maxSpawnFanout,
    },
    profiles: BUDGET_PROFILES,
    canSetPremium: access.spaceOwner,
    canTopUp: access.spaceOwner,
  };
}

async function requireSpaceOwner(prisma: PrismaClient, actor: Actor): Promise<void> {
  if (!(await isSpaceOwner(prisma, actor))) {
    throw new HttpError(403, "Only a space owner can change this");
  }
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Expected a JSON object");
  }
  return body as Record<string, unknown>;
}

function unwrap<T>(parsed: Parsed<T>): T {
  if (!parsed.ok) throw new HttpError(400, parsed.error);
  return parsed.value;
}

/** Known fields only; anything else in the body (a spaceId included) is ignored. */
export function parseBotPatch(body: Record<string, unknown>): BotBudgetPatch {
  const patch: BotBudgetPatch = {};
  if (body.profile !== undefined) {
    if (!isBudgetProfile(body.profile)) throw new HttpError(400, "Unknown budget profile");
    patch.profile = body.profile;
  }
  if (body.customDailyUsd !== undefined) {
    patch.customDailyUsd = unwrap(parseBudgetAmount(body.customDailyUsd));
    patch.profile ??= "custom";
    if (patch.profile !== "custom") {
      throw new HttpError(400, "A custom amount needs the custom profile");
    }
  }
  if (body.premium !== undefined) {
    if (typeof body.premium !== "boolean") throw new HttpError(400, "premium must be a boolean");
    patch.premium = body.premium;
  }
  for (const key of ["maxConcurrentRuns", "maxSpawnDepth", "maxSpawnFanout"] as const) {
    if (body[key] !== undefined) patch[key] = unwrap(parseLimit(body[key]));
  }
  if (Object.keys(patch).length === 0) throw new HttpError(400, "Nothing to change");
  return patch;
}

async function recordPolicyChange(
  tx: Prisma.TransactionClient,
  actor: Actor,
  input: { botId?: string; summary: string; detail: Record<string, unknown> },
) {
  await getAuditWriter()?.recordInTransaction(tx, {
    spaceId: actor.spaceId,
    botId: input.botId ?? null,
    actor: { type: "human", id: actor.userId },
    kind: "policy.change",
    summary: input.summary,
    detail: input.detail,
  });
}

/**
 * Server-side premium rule for model selection: with budgets on, a Fable or Mythos class
 * model can be chosen only for a bot marked premium.
 */
export async function assertPremiumModelAllowed(
  prisma: PrismaClient,
  input: { spaceId: string; botId: string; modelId: string | null | undefined },
): Promise<void> {
  if (!getBudgetPolicy() || !isPremiumModelId(input.modelId)) return;
  const settings = await loadBotBudget(prisma, input);
  if (!settings.premium) throw new ORPCError("BAD_REQUEST", { message: PREMIUM_MODEL_REFUSAL });
}
