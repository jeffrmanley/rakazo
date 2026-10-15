-- CreateTable
CREATE TABLE "ext_run_slot_waits" (
    "runId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "runCreatedAt" TIMESTAMP(3) NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ext_run_slot_waits_pkey" PRIMARY KEY ("runId")
);

-- CreateIndex
CREATE INDEX "ext_run_slot_waits_botId_runCreatedAt_idx" ON "ext_run_slot_waits"("botId", "runCreatedAt");
