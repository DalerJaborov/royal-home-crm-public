-- UNKNOWN remains quarantined forever for its original peer/part. It is not
-- an active execution after a finished attempt and the five-minute drain.
-- This migration performs no data updates, settlement, requeue or resend.
BEGIN;
CREATE FUNCTION customer_agent_delivery_requires_idle() RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "CustomerOutboxPart" p WHERE p."agentRevisionId" IS NOT NULL AND (
      p."status" IN ('READY','IN_FLIGHT') OR
      (p."status"='UNKNOWN' AND NOT (
        p."leaseOwner" IS NULL AND p."leaseUntil" IS NULL AND
        EXISTS (SELECT 1 FROM "CustomerDeliveryAttempt" a WHERE a."partId"=p."id"
          AND a."outcome"='UNKNOWN' AND a."finishedAt" < clock_timestamp()-interval '5 minutes') AND
        NOT EXISTS (SELECT 1 FROM "CustomerDeliveryAttempt" a WHERE a."partId"=p."id"
          AND (a."outcome"='IN_FLIGHT' OR a."finishedAt" IS NULL OR a."finishedAt">=clock_timestamp()-interval '5 minutes'))
      ))
    )
  )
$$;
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
    customer_agent_delivery_requires_idle() OR
    EXISTS(SELECT 1 FROM "CustomerPublicEffect" WHERE "status"='IN_FLIGHT' AND "createdAt">clock_timestamp()-interval '5 minutes') OR
    EXISTS(SELECT 1 FROM "AiProviderOperation" WHERE "policyKey"='royal-customer-gemini' AND "reservedUsd">0
      AND "status"='OPEN' AND "deadlineAt">clock_timestamp()) THEN
    RAISE EXCEPTION 'Customer revision advance requires idle';
  END IF;
  RETURN NEW;
END $$;
COMMIT;
