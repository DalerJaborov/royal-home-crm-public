-- 515: historical non-resumable financial holds are not active executions.
-- Preserve every reserve/attempt/receipt. Never reopen or settle an old call.
BEGIN;
CREATE OR REPLACE FUNCTION customer_agent_advance_insert() RETURNS trigger LANGUAGE plpgsql AS $$
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
    EXISTS(SELECT 1 FROM "AiProviderOperation" WHERE "policyKey"='royal-customer-gemini' AND "reservedUsd">0
      AND "status"='OPEN' AND "deadlineAt">clock_timestamp()) THEN
    RAISE EXCEPTION 'Customer revision advance requires idle';
  END IF;
  RETURN NEW;
END $$;
COMMIT;
