-- 31.10.2026, owner: move old LEGACY subjects to the core. Additive and
-- append-only: the original assignment row stays immutable (UPDATE trigger is
-- untouched); a cutover is a NEW row of generation 1 that supersedes it.
-- Existing rows become generation 0 with no predecessor/reason.
BEGIN;
ALTER TABLE "CustomerAgentRolloutAssignment"
  ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "supersedesAssignmentId" TEXT,
  ADD COLUMN "transitionReason" TEXT;
ALTER TABLE "CustomerAgentRolloutAssignment"
  ADD CONSTRAINT "CustomerAgentRolloutAssignment_supersedesAssignmentId_fkey" FOREIGN KEY ("supersedesAssignmentId")
    REFERENCES "CustomerAgentRolloutAssignment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "customer_rollout_generation_shape" CHECK (
    ("generation"=0 AND "supersedesAssignmentId" IS NULL AND "transitionReason" IS NULL) OR
    ("generation">0 AND "supersedesAssignmentId" IS NOT NULL AND "transitionReason" IS NOT NULL AND "lane"='CORE')
  );
CREATE UNIQUE INDEX "CustomerAgentRolloutAssignment_supersedesAssignmentId_key" ON "CustomerAgentRolloutAssignment"("supersedesAssignmentId");
CREATE UNIQUE INDEX "CustomerAgentRolloutAssignment_subject_generation_key"
  ON "CustomerAgentRolloutAssignment"("surface","endpointScopeId","subjectKey","generation");
-- The one-row-per-subject constraint is replaced by one row per subject AND generation.
ALTER TABLE "CustomerAgentRolloutAssignment" DROP CONSTRAINT "CustomerAgentRolloutAssignment_subject_key";

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
  -- Cutover: only DM, only LEGACY → CORE, exactly the next generation of the same subject.
  IF NEW."generation"<>0 THEN
    SELECT * INTO prev FROM "CustomerAgentRolloutAssignment" WHERE "id"=NEW."supersedesAssignmentId" FOR SHARE;
    IF NOT FOUND OR NEW."surface"<>'dm' OR NEW."lane"<>'CORE' OR NOT configured OR
      NEW."transitionReason" IS DISTINCT FROM 'legacy_cutover_owner_31_10' OR prev."lane"<>'LEGACY' OR
      prev."surface"<>NEW."surface" OR prev."endpointScopeId"<>NEW."endpointScopeId" OR prev."subjectKey"<>NEW."subjectKey" OR
      prev."generation"<>NEW."generation"-1 THEN RAISE EXCEPTION 'Invalid lane cutover'; END IF;
  END IF;
  RETURN NEW;
END $$;
COMMIT;
