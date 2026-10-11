-- One bot can be linked from several chat apps. Replies follow the identity a
-- message arrived through; proactive messages go to the bot's home identity.

-- DropIndex
DROP INDEX "messaging_identities_botId_key";

-- CreateIndex
CREATE INDEX "messaging_identities_botId_idx" ON "messaging_identities"("botId");

-- AlterTable
ALTER TABLE "bots" ADD COLUMN "homeMessagingIdentityId" TEXT;

-- AlterTable
ALTER TABLE "runs" ADD COLUMN "messagingIdentityId" TEXT;

-- Existing single links become the home identity.
UPDATE "bots" b
SET "homeMessagingIdentityId" = i."id"
FROM "messaging_identities" i
WHERE i."botId" = b."id";
