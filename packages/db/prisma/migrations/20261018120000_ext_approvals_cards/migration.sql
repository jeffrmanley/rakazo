-- A bot's approval policy is keyed by its space and bot, like every read of it.
ALTER TABLE "ext_bot_approval_policies" DROP CONSTRAINT "ext_bot_approval_policies_pkey";
DROP INDEX "ext_bot_approval_policies_spaceId_idx";
ALTER TABLE "ext_bot_approval_policies" ADD CONSTRAINT "ext_bot_approval_policies_pkey" PRIMARY KEY ("spaceId", "botId");

-- Cards move to their own table: one per approver's linked identity.
ALTER TABLE "ext_approvals" DROP COLUMN "cardProvider",
DROP COLUMN "cardThreadId",
DROP COLUMN "cardMessageId";

-- CreateTable
CREATE TABLE "ext_approval_cards" (
    "id" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "identityId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ext_approval_cards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ext_approval_cards_approvalId_identityId_key" ON "ext_approval_cards"("approvalId", "identityId");

-- The API records the EXT_APPROVALS value it runs with; a worker with another value refuses to start.
ALTER TABLE "deployment_settings" ADD COLUMN "extApprovals" BOOLEAN;

-- The bot that added an MCP server itself (add_mcp_server); null when a person added it.
ALTER TABLE "mcp_servers" ADD COLUMN "addedByBotId" TEXT;
