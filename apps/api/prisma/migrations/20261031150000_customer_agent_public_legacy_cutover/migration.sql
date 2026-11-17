-- 31.10.2026, owner (step 3 of the legacy bot removal): the append-only
-- LEGACY → CORE cutover of 20261031120000 also covers public comment threads
-- (surface public_comment, IG/FB). Only the insert trigger function changes:
-- same rules (configured campaign, CORE only, exact next generation of the
-- same subject, fixed reason); the surface may now be dm OR public_comment.
-- Rollback: re-apply the function body of 20261031120000 (dm only).
BEGIN;
CREATE OR REPLACE FUNCTION customer_rollout_assignment_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "CustomerEndpointScope"; p "CustomerRuntimePolicy"; configured BOOLEAN; prev "CustomerAgentRolloutAssignment";
BEGIN
  SELECT * INTO s FROM "CustomerEndpointScope" WHERE "id"=NEW."endpointScopeId" FOR SHARE;
  IF NOT FOUND OR (NEW."surface"='dm' AND (s."kind"<>'NORMAL' OR s."realmKey"<>'royal-home')) OR
    (NEW."surface"='public_comment' AND (s."kind"<>'PUBLIC' OR s."realmKey"<>'customer-public')) THEN
    RAISE EXCEPTION 'Invalid rollout namespace';
  END IF;
  SELECT * INTO p FROM "CustomerRuntimePolicy" WHERE "id"='singleton' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Rollout policy missing'; END IF;
  configured := NEW."cohortId" IS NOT NULL;
  IF NOT configured THEN
    IF NEW."lane"<>'LEGACY' OR p."rolloutConfig" IS NOT NULL OR
      NOT(p."contractVersion"='compat' OR p."rolloutMode"='OFF') THEN RAISE EXCEPTION 'Invalid baseline rollout'; END IF;
  ELSE
    IF jsonb_typeof(p."rolloutConfig") IS DISTINCT FROM 'object' OR
      p."rolloutConfig"->>'cohortId' IS DISTINCT FROM NEW."cohortId" OR
      p."rolloutConfig"->>'candidateRevisionId' IS DISTINCT FROM NEW."candidateRevisionId" OR
      p."activeAgentRevisionId" IS DISTINCT FROM NEW."candidateRevisionId" OR
      EXISTS(SELECT 1 FROM "CustomerAgentRolloutAssignment" WHERE "cohortId"=NEW."cohortId"
        AND "candidateRevisionId" IS DISTINCT FROM NEW."candidateRevisionId") THEN RAISE EXCEPTION 'Rollout campaign changed'; END IF;
    IF NEW."lane"='CORE' AND (p."contractVersion"<>'scoped' OR p."rolloutMode"<>'ACTIVE' OR
      NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p."rolloutConfig"->'allowed') a
        WHERE a->>'surface'=NEW."surface" AND a->>'endpointScopeId'=NEW."endpointScopeId" AND a->>'channel'=s."channel")) THEN
      RAISE EXCEPTION 'Core rollout not allowed';
    END IF;
  END IF;
  -- Cutover: DM and public comment threads, only LEGACY → CORE, exactly the next generation of the same subject.
  IF NEW."generation"<>0 THEN
    SELECT * INTO prev FROM "CustomerAgentRolloutAssignment" WHERE "id"=NEW."supersedesAssignmentId" FOR SHARE;
    IF NOT FOUND OR NEW."surface" NOT IN ('dm','public_comment') OR NEW."lane"<>'CORE' OR NOT configured OR
      NEW."transitionReason" IS DISTINCT FROM 'legacy_cutover_owner_31_10' OR prev."lane"<>'LEGACY' OR
      prev."surface"<>NEW."surface" OR prev."endpointScopeId"<>NEW."endpointScopeId" OR prev."subjectKey"<>NEW."subjectKey" OR
      prev."generation"<>NEW."generation"-1 THEN RAISE EXCEPTION 'Invalid lane cutover'; END IF;
  END IF;
  RETURN NEW;
END $$;
COMMIT;
