-- 514: append-only, explicitly approved future-turn revision advancement.
-- No rewrite of assignments, original intake pins, public origins or receipts.
BEGIN;
CREATE TABLE "CustomerAgentRevisionAdvance" (
  "id" TEXT PRIMARY KEY,
  "fromRevisionId" TEXT NOT NULL REFERENCES "CustomerAgentRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "fromCohortId" TEXT NOT NULL,
  "toRevisionId" TEXT NOT NULL REFERENCES "CustomerAgentRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "toCohortId" TEXT NOT NULL,
  "policyRevision" BIGINT NOT NULL CHECK ("policyRevision">0),
  "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerAgentRevisionAdvance_fromRevisionId_fromCohortId_key" UNIQUE ("fromRevisionId","fromCohortId"),
  CONSTRAINT "CustomerAgentRevisionAdvance_toCohortId_key" UNIQUE ("toCohortId"),
  CHECK ("fromRevisionId"<>"toRevisionId" AND "fromCohortId"<>"toCohortId")
);
CREATE FUNCTION customer_agent_revision_reachable(from_revision TEXT,from_cohort TEXT,to_revision TEXT,to_cohort TEXT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  WITH RECURSIVE lineage(revision,cohort,depth,path) AS (
    SELECT from_revision,from_cohort,0,ARRAY[from_revision || ':' || from_cohort]
    UNION ALL
    SELECT e."toRevisionId",e."toCohortId",l.depth+1,l.path || (e."toRevisionId" || ':' || e."toCohortId")
    FROM lineage l JOIN "CustomerAgentRevisionAdvance" e ON e."fromRevisionId"=l.revision AND e."fromCohortId"=l.cohort
    WHERE l.depth<16 AND NOT(e."toRevisionId" || ':' || e."toCohortId"=ANY(l.path))
  ) SELECT EXISTS(SELECT 1 FROM lineage WHERE revision=to_revision AND (to_cohort IS NULL OR cohort=to_cohort))
$$;
CREATE FUNCTION customer_agent_advance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable customer revision advance'; END $$;
CREATE TRIGGER customer_agent_advance_immutable BEFORE UPDATE OR DELETE ON "CustomerAgentRevisionAdvance"
  FOR EACH ROW EXECUTE FUNCTION customer_agent_advance_immutable();
CREATE FUNCTION customer_agent_advance_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p "CustomerRuntimePolicy";
BEGIN
  SELECT * INTO p FROM "CustomerRuntimePolicy" WHERE "id"='singleton' FOR UPDATE;
  IF NOT FOUND OR p."activeAgentRevisionId" IS DISTINCT FROM NEW."fromRevisionId" OR
    p."rolloutConfig"->>'cohortId' IS DISTINCT FROM NEW."fromCohortId" OR NEW."policyRevision"<>p."policyRevision"+1 OR
    EXISTS(SELECT 1 FROM "CustomerAgentRolloutAssignment" WHERE "cohortId"=NEW."toCohortId") OR
    customer_agent_revision_reachable(NEW."toRevisionId",NEW."toCohortId",NEW."fromRevisionId",NULL) THEN
    RAISE EXCEPTION 'Customer revision advance context changed';
  END IF;
  IF EXISTS(SELECT 1 FROM "CustomerPropertyIngressTicket" WHERE "intakeAgentRevisionId" IS NOT NULL AND "processingState" IN ('RECEIVED','CLAIMED')) OR
    EXISTS(SELECT 1 FROM "InstagramComment" WHERE "publicOriginCiphertext" IS NOT NULL AND "status" IN ('PENDING','WORKING','WORKING_STAFF','ERROR')) OR
    EXISTS(SELECT 1 FROM "TelegramGroupComment" WHERE "publicOriginCiphertext" IS NOT NULL AND "status" IN ('PENDING','WORKING','WORKING_STAFF','ERROR')) OR
    EXISTS(SELECT 1 FROM "CustomerOutboxPart" WHERE "agentRevisionId" IS NOT NULL AND "status" IN ('READY','IN_FLIGHT','UNKNOWN')) OR
    EXISTS(SELECT 1 FROM "AiProviderOperation" WHERE "policyKey"='royal-customer-gemini' AND "reservedUsd">0) THEN
    RAISE EXCEPTION 'Customer revision advance requires idle';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_agent_advance_insert BEFORE INSERT ON "CustomerAgentRevisionAdvance"
  FOR EACH ROW EXECUTE FUNCTION customer_agent_advance_insert();

CREATE OR REPLACE FUNCTION customer_rollout_ticket_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "CustomerAgentRolloutAssignment"; p "CustomerRuntimePolicy";
BEGIN
  IF TG_OP='UPDATE' AND NEW."rolloutAssignmentId" IS DISTINCT FROM OLD."rolloutAssignmentId" THEN
    RAISE EXCEPTION 'Immutable source rollout assignment';
  END IF;
  IF NEW."rolloutAssignmentId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO a FROM "CustomerAgentRolloutAssignment" WHERE "id"=NEW."rolloutAssignmentId";
  IF NOT FOUND OR a."surface"<>'dm' OR NEW."endpointScopeId" IS DISTINCT FROM a."endpointScopeId" OR
    (a."lane"='CORE' AND (NEW."intakeAgentRevisionId" IS NULL OR NOT customer_agent_revision_reachable(
      a."candidateRevisionId",a."cohortId",NEW."intakeAgentRevisionId",NULL))) OR
    (a."lane"='LEGACY' AND NEW."intakeAgentRevisionId" IS NOT NULL) THEN RAISE EXCEPTION 'Source rollout/pin mismatch'; END IF;
  IF TG_OP='INSERT' AND a."lane"='CORE' THEN
    SELECT * INTO p FROM "CustomerRuntimePolicy" WHERE "id"='singleton' FOR SHARE;
    IF p."rolloutMode"<>'ACTIVE' OR p."activeAgentRevisionId" IS DISTINCT FROM NEW."intakeAgentRevisionId" THEN
      RAISE EXCEPTION 'New source revision changed';
    END IF;
  END IF;
  RETURN NEW;
END $$;
COMMIT;
