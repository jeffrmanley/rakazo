-- CreateTable
CREATE TABLE "ext_bot_approval_policies" (
    "botId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "gatedClasses" TEXT[],
    "approverUserIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "ext_bot_approval_policies_pkey" PRIMARY KEY ("botId")
);

-- CreateTable
CREATE TABLE "ext_approvals" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "effectId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "riskClass" TEXT NOT NULL,
    "callHash" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "approverIds" TEXT[],
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "decidedVia" TEXT,
    "interactionId" TEXT,
    "decisionNote" TEXT,
    "cardProvider" TEXT,
    "cardThreadId" TEXT,
    "cardMessageId" TEXT,

    CONSTRAINT "ext_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ext_bot_approval_policies_spaceId_idx" ON "ext_bot_approval_policies"("spaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ext_approvals_effectId_key" ON "ext_approvals"("effectId");

-- CreateIndex
CREATE INDEX "ext_approvals_status_expiresAt_idx" ON "ext_approvals"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "ext_approvals_spaceId_status_idx" ON "ext_approvals"("spaceId", "status");

-- CreateIndex
CREATE INDEX "ext_approvals_runId_idx" ON "ext_approvals"("runId");

-- A status outside the module's vocabulary is a bug, not data.
ALTER TABLE "ext_approvals" ADD CONSTRAINT "ext_approvals_status_check"
  CHECK ("status" IN ('pending', 'allow', 'deny', 'expired', 'invalid'));
