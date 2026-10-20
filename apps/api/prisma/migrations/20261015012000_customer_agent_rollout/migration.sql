-- Additive rollout assignment; existing original source pins are retained.
-- Applied only through normal Prisma/release verification.
BEGIN;
ALTER TABLE "CustomerRuntimePolicy" ADD COLUMN "rolloutConfig" JSONB;
CREATE TABLE "CustomerAgentRolloutAssignment" (
  "id" TEXT PRIMARY KEY,
  "cohortId" TEXT,
  "surface" TEXT NOT NULL CHECK ("surface" IN ('dm','public_comment')),
  "endpointScopeId" TEXT NOT NULL REFERENCES "CustomerEndpointScope"("id") ON DELETE CASCADE ON UPDATE RESTRICT,
  "subjectKey" TEXT NOT NULL CHECK ("subjectKey" ~ '^[a-f0-9]{64}$'),
  "bucketBps" INTEGER CHECK ("bucketBps" BETWEEN 0 AND 9999),
  "lane" TEXT NOT NULL CHECK ("lane" IN ('LEGACY','CORE')),
  "candidateRevisionId" TEXT REFERENCES "CustomerAgentRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_rollout_campaign_shape" CHECK (
    ("cohortId" IS NOT NULL AND "candidateRevisionId" IS NOT NULL AND "bucketBps" IS NOT NULL) OR
    ("lane"='LEGACY' AND "cohortId" IS NULL AND "candidateRevisionId" IS NULL AND "bucketBps" IS NULL)
  ),
  CONSTRAINT "CustomerAgentRolloutAssignment_subject_key" UNIQUE ("surface","endpointScopeId","subjectKey")
);
CREATE INDEX "CustomerAgentRolloutAssignment_cohortId_idx" ON "CustomerAgentRolloutAssignment"("cohortId");
ALTER TABLE "CustomerPropertyIngressTicket" ADD COLUMN "rolloutAssignmentId" TEXT
  REFERENCES "CustomerAgentRolloutAssignment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "InstagramComment" ADD COLUMN "publicRolloutAssignmentId" TEXT
  REFERENCES "CustomerAgentRolloutAssignment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "TelegramGroupComment" ADD COLUMN "publicRolloutAssignmentId" TEXT
  REFERENCES "CustomerAgentRolloutAssignment"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "CustomerPropertyIngressTicket_rolloutAssignmentId_idx" ON "CustomerPropertyIngressTicket"("rolloutAssignmentId");
CREATE INDEX "InstagramComment_publicRolloutAssignmentId_idx" ON "InstagramComment"("publicRolloutAssignmentId");
CREATE INDEX "TelegramGroupComment_publicRolloutAssignmentId_idx" ON "TelegramGroupComment"("publicRolloutAssignmentId");

CREATE FUNCTION customer_rollout_assignment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Immutable rollout assignment'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_rollout_assignment_immutable BEFORE UPDATE ON "CustomerAgentRolloutAssignment"
  FOR EACH ROW EXECUTE FUNCTION customer_rollout_assignment_immutable();
-- No DELETE guard: exact own-scope cleanup cascades only unreferenced rows.
-- Account delete SET NULL/tombstone keeps scope + assignment. No reset API.

CREATE FUNCTION customer_rollout_assignment_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "CustomerEndpointScope"; p "CustomerRuntimePolicy"; configured BOOLEAN;
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
  RETURN NEW;
END $$;
CREATE TRIGGER customer_rollout_assignment_insert BEFORE INSERT ON "CustomerAgentRolloutAssignment"
  FOR EACH ROW EXECUTE FUNCTION customer_rollout_assignment_insert();

-- Existing function name and monotonic guard retained. Settings/credential
-- triggers can still bump policyRevision without changing semantic fields.
CREATE OR REPLACE FUNCTION customer_policy_revisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."policyRevision" < OLD."policyRevision" THEN RAISE EXCEPTION 'Policy revision cannot decrease'; END IF;
  IF ROW(NEW."contractVersion",NEW."rolloutMode",NEW."capabilities",NEW."activeAgentRevisionId",NEW."rolloutConfig") IS DISTINCT FROM
    ROW(OLD."contractVersion",OLD."rolloutMode",OLD."capabilities",OLD."activeAgentRevisionId",OLD."rolloutConfig") THEN
    NEW."policyRevision" := GREATEST(NEW."policyRevision",OLD."policyRevision"+1);
    NEW."updatedAt" := now();
  END IF;
  IF NEW."rolloutConfig" IS NOT NULL AND EXISTS(SELECT 1 FROM "CustomerAgentRolloutAssignment" a
    WHERE a."cohortId"=NEW."rolloutConfig"->>'cohortId' AND a."candidateRevisionId" IS DISTINCT FROM NEW."rolloutConfig"->>'candidateRevisionId') THEN
    RAISE EXCEPTION 'Cannot reuse rollout cohort with another candidate';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION customer_rollout_ticket_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "CustomerAgentRolloutAssignment";
BEGIN
  IF TG_OP='UPDATE' AND NEW."rolloutAssignmentId" IS DISTINCT FROM OLD."rolloutAssignmentId" THEN
    RAISE EXCEPTION 'Immutable source rollout assignment';
  END IF;
  IF NEW."rolloutAssignmentId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO a FROM "CustomerAgentRolloutAssignment" WHERE "id"=NEW."rolloutAssignmentId";
  IF NOT FOUND OR a."surface"<>'dm' OR NEW."endpointScopeId" IS DISTINCT FROM a."endpointScopeId" OR
    (a."lane"='CORE' AND NEW."intakeAgentRevisionId" IS DISTINCT FROM a."candidateRevisionId") OR
    (a."lane"='LEGACY' AND NEW."intakeAgentRevisionId" IS NOT NULL) THEN RAISE EXCEPTION 'Source rollout/pin mismatch'; END IF;
  -- Exact subject/event preimage is validated by the genuine producer closure.
  -- SQL shape alone does not authenticate an encrypted payload or MID.
  RETURN NEW;
END $$;
CREATE TRIGGER customer_rollout_ticket_source BEFORE INSERT OR UPDATE ON "CustomerPropertyIngressTicket"
  FOR EACH ROW EXECUTE FUNCTION customer_rollout_ticket_source();
CREATE FUNCTION customer_rollout_public_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "CustomerAgentRolloutAssignment"; s "CustomerEndpointScope"; resource TEXT; channel_name TEXT;
BEGIN
  IF TG_OP='UPDATE' AND NEW."publicRolloutAssignmentId" IS DISTINCT FROM OLD."publicRolloutAssignmentId" THEN
    RAISE EXCEPTION 'Immutable public source rollout assignment';
  END IF;
  IF NEW."publicRolloutAssignmentId" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO a FROM "CustomerAgentRolloutAssignment" WHERE "id"=NEW."publicRolloutAssignmentId";
  IF NOT FOUND OR a."surface"<>'public_comment' THEN RAISE EXCEPTION 'Public source assignment mismatch'; END IF;
  SELECT * INTO s FROM "CustomerEndpointScope" WHERE "id"=a."endpointScopeId";
  IF TG_TABLE_NAME='InstagramComment' THEN resource:=NEW."accountExternalId"; channel_name:=NEW."channel";
  ELSE resource:=NEW."groupChatId"; channel_name:='TELEGRAM'; END IF;
  IF s."channel" IS DISTINCT FROM channel_name OR s."publicResourceId" IS DISTINCT FROM resource OR
    (a."lane"='LEGACY' AND (NEW."publicOriginVersion" IS NOT NULL OR NEW."publicOriginCiphertext" IS NOT NULL)) THEN
    RAISE EXCEPTION 'Public namespace or origin conflicts with assignment';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_rollout_public_source BEFORE INSERT OR UPDATE ON "InstagramComment"
  FOR EACH ROW EXECUTE FUNCTION customer_rollout_public_source();
CREATE TRIGGER customer_rollout_public_source BEFORE INSERT OR UPDATE ON "TelegramGroupComment"
  FOR EACH ROW EXECUTE FUNCTION customer_rollout_public_source();
COMMIT;
