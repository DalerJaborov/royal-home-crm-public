-- Prod 26.11.2026: a worker killed mid-turn by an auto-deploy restart left one
-- ticket CLAIMED forever (nothing releases a lease whose owner died), and the
-- idle check counted it as in-flight, so every later revision advance failed
-- and the core stayed silent on all channels.
--
-- A claim's lease ends exactly at the original provider deadline, every write
-- of the turn re-checks "leaseUntil">clock_timestamp() and the pin refuses a new
-- claim after that deadline. So a CLAIMED ticket whose lease AND provider
-- deadline (and its pinned provider operation's deadline) are past by five
-- minutes can no longer act. It is not in-flight.
--
-- ONE DOOR for "the core must be idle": customer_agent_core_idle_blockers().
-- The advance trigger, the owner publication check and the Instagram app
-- rebinding check all call it; the alert reads the same list to say WHAT blocks.
-- This migration performs no data updates.
BEGIN;
CREATE FUNCTION customer_agent_claim_orphaned(p_state text, p_lease timestamp(3), p_deadline timestamp(3), p_operation text)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT p_state='CLAIMED' AND p_lease IS NOT NULL AND p_deadline IS NOT NULL
    AND p_lease < clock_timestamp()-interval '5 minutes' AND p_deadline < clock_timestamp()-interval '5 minutes'
    AND NOT EXISTS(SELECT 1 FROM "AiProviderOperation" o WHERE o."id"=p_operation AND o."status"='OPEN'
      AND o."deadlineAt" >= clock_timestamp()-interval '5 minutes')
$$;
CREATE FUNCTION customer_agent_core_idle_blockers() RETURNS text[] LANGUAGE sql VOLATILE AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN EXISTS(SELECT 1 FROM "CustomerPropertyIngressTicket" t WHERE t."intakeAgentRevisionId" IS NOT NULL
      AND t."processingState" IN ('RECEIVED','CLAIMED')
      AND NOT customer_agent_claim_orphaned(t."processingState",t."leaseUntil",t."providerDeadlineAt",t."providerOperationId")) THEN 'customer_turn' END,
    CASE WHEN EXISTS(SELECT 1 FROM "InstagramComment" WHERE "publicOriginCiphertext" IS NOT NULL
      AND "status" IN ('PENDING','WORKING','WORKING_STAFF','ERROR')) THEN 'instagram_comment' END,
    CASE WHEN EXISTS(SELECT 1 FROM "TelegramGroupComment" WHERE "publicOriginCiphertext" IS NOT NULL
      AND "status" IN ('PENDING','WORKING','WORKING_STAFF','ERROR')) THEN 'telegram_comment' END,
    CASE WHEN customer_agent_delivery_requires_idle() THEN 'delivery' END,
    CASE WHEN EXISTS(SELECT 1 FROM "CustomerPublicEffect" WHERE "status"='IN_FLIGHT'
      AND "createdAt">clock_timestamp()-interval '5 minutes') THEN 'public_effect' END,
    CASE WHEN EXISTS(SELECT 1 FROM "AiProviderOperation" WHERE "policyKey"='royal-customer-gemini' AND "reservedUsd">0
      AND "status"='OPEN' AND "deadlineAt">clock_timestamp()) THEN 'provider_operation' END
  ]::text[], NULL)
$$;
CREATE FUNCTION customer_agent_core_requires_idle() RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT cardinality(customer_agent_core_idle_blockers())>0
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
  IF customer_agent_core_requires_idle() THEN
    RAISE EXCEPTION 'Customer revision advance requires idle';
  END IF;
  RETURN NEW;
END $$;
COMMIT;
