-- Prod 26.11.2026: a worker killed mid-turn by an auto-deploy restart left one
-- ticket CLAIMED forever (nothing releases a lease whose owner died), and the
-- idle check counted it as in-flight, so every later revision advance failed
-- and the core stayed silent on all channels.
--
-- A ticket that can never act again is not in-flight:
--  * CLAIMED: the lease ends exactly at the original provider deadline, every
--    write of the turn re-checks "leaseUntil">clock_timestamp(), and no new
--    claim is possible after that deadline. Orphaned = lease AND provider
--    deadline past by five minutes, and no OPEN pinned provider operation
--    with a later deadline.
--  * RECEIVED: the pin refuses ("expired") a turn past receipt + the revision
--    deadline (at most 15 minutes, customerAgentTurnDeadline). Orphaned = that
--    bound (or its own provider deadline, if pinned) past by five minutes AND no
--    live inbox job for it (PENDING, or RUNNING with a fresh lock: the runner
--    reclaims a RUNNING lock older than 15 minutes, STUCK_RUNNING_MIN).
--
-- ONE DOOR for "the core must be idle": customer_agent_core_idle_blockers().
-- The advance trigger, the owner publication check and the Instagram app
-- rebinding check all call it; the alert reads the same list to say WHAT
-- blocks; the recovery sweep (customerAgentOrphanClaims.ts) uses the same
-- customer_agent_ticket_orphaned(). This migration performs no data updates.
BEGIN;
CREATE FUNCTION customer_agent_ticket_orphaned(p_event_key text, p_state text, p_received timestamp(3), p_lease timestamp(3),
  p_deadline timestamp(3), p_operation text)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT CASE
    WHEN p_state='CLAIMED' THEN p_lease IS NOT NULL AND p_deadline IS NOT NULL
      AND p_lease < clock_timestamp()-interval '5 minutes' AND p_deadline < clock_timestamp()-interval '5 minutes'
      AND NOT EXISTS(SELECT 1 FROM "AiProviderOperation" o WHERE o."id"=p_operation AND o."status"='OPEN'
        AND o."deadlineAt" >= clock_timestamp()-interval '5 minutes')
    WHEN p_state='RECEIVED' THEN p_received IS NOT NULL
      AND COALESCE(p_deadline, p_received+interval '15 minutes') < clock_timestamp()-interval '5 minutes'
      AND NOT EXISTS(SELECT 1 FROM "BackgroundJob" j WHERE j."type"='customer-inbox-consume' AND j."payload"->>'eventKey'=p_event_key
        AND (j."status"='PENDING' OR (j."status"='RUNNING' AND j."lockedAt" >= clock_timestamp()-interval '15 minutes')))
    ELSE false END
$$;
CREATE FUNCTION customer_agent_core_idle_blockers() RETURNS text[] LANGUAGE sql VOLATILE AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN EXISTS(SELECT 1 FROM "CustomerPropertyIngressTicket" t WHERE t."intakeAgentRevisionId" IS NOT NULL
      AND t."processingState" IN ('RECEIVED','CLAIMED')
      AND NOT customer_agent_ticket_orphaned(t."eventKey",t."processingState",t."receivedAt",t."leaseUntil",t."providerDeadlineAt",t."providerOperationId")) THEN 'customer_turn' END,
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
