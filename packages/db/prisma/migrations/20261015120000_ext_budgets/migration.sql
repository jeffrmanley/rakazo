-- CreateTable
CREATE TABLE "ext_bot_budgets" (
    "botId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "profile" TEXT NOT NULL DEFAULT 'assistant',
    "customDailyUsd" DOUBLE PRECISION,
    "premium" BOOLEAN NOT NULL DEFAULT false,
    "maxConcurrentRuns" INTEGER,
    "maxSpawnDepth" INTEGER,
    "maxSpawnFanout" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "ext_bot_budgets_pkey" PRIMARY KEY ("botId")
);

-- CreateTable
CREATE TABLE "ext_space_budgets" (
    "spaceId" TEXT NOT NULL,
    "dailyUsd" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "ext_space_budgets_pkey" PRIMARY KEY ("spaceId")
);

-- CreateTable
CREATE TABLE "ext_budget_topups" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT,
    "day" TEXT NOT NULL,
    "amountUsd" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "ext_budget_topups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ext_budget_notices" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ext_budget_notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ext_run_spawns" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "parentRunId" TEXT NOT NULL,
    "childRunId" TEXT,
    "tool" TEXT NOT NULL,
    "depth" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ext_run_spawns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ext_bot_budgets_spaceId_idx" ON "ext_bot_budgets"("spaceId");

-- CreateIndex
CREATE INDEX "ext_budget_topups_spaceId_day_idx" ON "ext_budget_topups"("spaceId", "day");

-- CreateIndex
CREATE INDEX "ext_budget_notices_spaceId_idx" ON "ext_budget_notices"("spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ext_budget_notices_kind_subjectId_period_key" ON "ext_budget_notices"("kind", "subjectId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "ext_run_spawns_childRunId_key" ON "ext_run_spawns"("childRunId");

-- CreateIndex
CREATE INDEX "ext_run_spawns_parentRunId_idx" ON "ext_run_spawns"("parentRunId");

-- CreateIndex
CREATE INDEX "ext_run_spawns_spaceId_idx" ON "ext_run_spawns"("spaceId");

-- CreateIndex
CREATE INDEX "usage_records_spaceId_createdAt_idx" ON "usage_records"("spaceId", "createdAt");

-- CreateIndex
CREATE INDEX "usage_records_spaceId_botId_createdAt_idx" ON "usage_records"("spaceId", "botId", "createdAt");
