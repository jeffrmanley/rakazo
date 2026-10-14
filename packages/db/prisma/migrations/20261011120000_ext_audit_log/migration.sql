-- CreateTable
CREATE TABLE "ext_audit_events" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "botId" TEXT,
    "runId" TEXT,
    "at" TIMESTAMP(3) NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "model" JSONB,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "ext_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ext_audit_chain_heads" (
    "spaceId" TEXT NOT NULL,
    "lastSeq" INTEGER NOT NULL,
    "lastHash" TEXT NOT NULL,
    "sealedThroughSeq" INTEGER NOT NULL DEFAULT -1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ext_audit_chain_heads_pkey" PRIMARY KEY ("spaceId")
);

-- CreateTable
CREATE TABLE "ext_audit_segments" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "fromSeq" INTEGER NOT NULL,
    "toSeq" INTEGER NOT NULL,
    "lastHash" TEXT NOT NULL,
    "sealedAt" TIMESTAMP(3) NOT NULL,
    "exportPath" TEXT,

    CONSTRAINT "ext_audit_segments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ext_audit_events_spaceId_seq_key" ON "ext_audit_events"("spaceId", "seq");

-- CreateIndex
CREATE INDEX "ext_audit_events_spaceId_at_idx" ON "ext_audit_events"("spaceId", "at");

-- CreateIndex
CREATE INDEX "ext_audit_events_spaceId_botId_seq_idx" ON "ext_audit_events"("spaceId", "botId", "seq");

-- CreateIndex
CREATE INDEX "ext_audit_events_spaceId_runId_seq_idx" ON "ext_audit_events"("spaceId", "runId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ext_audit_segments_spaceId_fromSeq_key" ON "ext_audit_segments"("spaceId", "fromSeq");

-- CreateIndex
CREATE INDEX "ext_audit_segments_spaceId_sealedAt_idx" ON "ext_audit_segments"("spaceId", "sealedAt");

-- Append-only enforcement. The application role (and anyone else below
-- superuser) can insert audit rows but never change or remove them. This
-- holds regardless of which database role runs the API or the worker; the
-- REVOKE for split-role deployments is documented in docs/governance/audit-log.md.
CREATE OR REPLACE FUNCTION ext_audit_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ext_audit: % is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER ext_audit_events_append_only
  BEFORE UPDATE OR DELETE ON "ext_audit_events"
  FOR EACH ROW EXECUTE FUNCTION ext_audit_reject_mutation();

CREATE TRIGGER ext_audit_events_no_truncate
  BEFORE TRUNCATE ON "ext_audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION ext_audit_reject_mutation();

CREATE TRIGGER ext_audit_segments_append_only
  BEFORE UPDATE OR DELETE ON "ext_audit_segments"
  FOR EACH ROW EXECUTE FUNCTION ext_audit_reject_mutation();

CREATE TRIGGER ext_audit_segments_no_truncate
  BEFORE TRUNCATE ON "ext_audit_segments"
  FOR EACH STATEMENT EXECUTE FUNCTION ext_audit_reject_mutation();
