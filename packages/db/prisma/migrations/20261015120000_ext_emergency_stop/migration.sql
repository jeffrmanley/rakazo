-- CreateTable
CREATE TABLE "ext_control_stops" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "spaceId" TEXT,
    "botId" TEXT,
    "reason" TEXT NOT NULL,
    "stoppedBy" TEXT NOT NULL,
    "stoppedAt" TIMESTAMP(3) NOT NULL,
    "resumedBy" TEXT,
    "resumedAt" TIMESTAMP(3),

    CONSTRAINT "ext_control_stops_pkey" PRIMARY KEY ("id"),
    -- Fork extension: a global stop has no space, a bot stop names its bot, and a
    -- resume records who resumed it.
    CONSTRAINT "ext_control_stops_scope_check" CHECK (
        "scope" IN ('bot', 'space', 'global')
        AND (("scope" = 'global') = ("spaceId" IS NULL))
        AND (("scope" = 'bot') = ("botId" IS NOT NULL))
        AND (("resumedAt" IS NULL) = ("resumedBy" IS NULL))
    )
);

-- CreateIndex
CREATE INDEX "ext_control_stops_spaceId_resumedAt_idx" ON "ext_control_stops"("spaceId", "resumedAt");

-- CreateIndex
CREATE INDEX "ext_control_stops_scope_resumedAt_idx" ON "ext_control_stops"("scope", "resumedAt");
