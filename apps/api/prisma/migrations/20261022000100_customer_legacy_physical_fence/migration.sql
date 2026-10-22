-- Additive foundation only. No routing/policy/master switch change or activation.
CREATE TABLE "CustomerLegacyPhysicalFence" ("id" TEXT PRIMARY KEY CHECK ("id"='singleton'));
INSERT INTO "CustomerLegacyPhysicalFence" ("id") VALUES ('singleton');
CREATE TABLE "CustomerLegacyPhysicalQuiescence" (
  "endpointScopeId" TEXT PRIMARY KEY REFERENCES "CustomerEndpointScope"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "scopeRevision" BIGINT NOT NULL CHECK ("scopeRevision">=0),
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE "CustomerLegacyPhysicalAttempt" (
  "id" TEXT PRIMARY KEY,
  -- Retained evidence survives ordinary account/scope removal. Never cascade
  -- away an ambiguous physical attempt or convert it into a fresh source.
  "endpointScopeId" TEXT,
  "scopeRevision" BIGINT,
  "channel" TEXT CHECK ("channel" IN ('INSTAGRAM','FACEBOOK','WHATSAPP','TELEGRAM','WEBSITE','YOUTUBE')),
  "surface" TEXT CHECK ("surface" IN ('dm','public_comment')),
  "targetDigest" TEXT NOT NULL CHECK ("targetDigest" ~ '^[a-f0-9]{64}$'),
  "payloadDigest" TEXT NOT NULL CHECK ("payloadDigest" ~ '^[a-f0-9]{64}$'),
  "operation" TEXT NOT NULL CHECK ("operation" IN ('message','reaction')),
  "effectKey" TEXT CHECK ("effectKey" ~ '^[a-f0-9]{64}$'),
  "sourceHash" TEXT CHECK ("sourceHash" ~ '^[a-f0-9]{64}$'),
  "actorKind" TEXT NOT NULL CHECK ("actorKind" IN ('LEGACY','STAFF','UNATTRIBUTED')),
  "actorId" TEXT,
  "status" TEXT NOT NULL CHECK ("status" IN ('ADMITTED','ACCEPTED','ACKNOWLEDGED','REJECTED','NOT_SENT','UNKNOWN')),
  "providerId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "finishedAt" TIMESTAMPTZ,
  CHECK (("endpointScopeId" IS NULL AND "scopeRevision" IS NULL) OR
    ("endpointScopeId" IS NOT NULL AND "scopeRevision" IS NOT NULL AND "scopeRevision">=0)),
  CHECK (("status"='ADMITTED')=("finishedAt" IS NULL)),
  CHECK (("effectKey" IS NULL)=("sourceHash" IS NULL)),
  CHECK (("actorKind"='STAFF')=("actorId" IS NOT NULL)),
  CHECK ("actorKind"<>'STAFF' OR "effectKey" IS NULL),
  CHECK ("status"<>'ACCEPTED' OR ("providerId" IS NOT NULL AND length("providerId")>0))
);
CREATE INDEX "CustomerLegacyPhysicalAttempt_idle" ON "CustomerLegacyPhysicalAttempt" ("status","endpointScopeId");
CREATE INDEX "CustomerLegacyPhysicalAttempt_endpointScopeId_sourceHash_idx" ON "CustomerLegacyPhysicalAttempt" ("endpointScopeId","sourceHash");
CREATE UNIQUE INDEX "CustomerLegacyPhysicalAttempt_effect_pending" ON "CustomerLegacyPhysicalAttempt" ("effectKey")
  WHERE "status" IN ('ADMITTED','UNKNOWN','ACCEPTED','ACKNOWLEDGED');
CREATE FUNCTION customer_legacy_physical_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR ROW(NEW."id",NEW."endpointScopeId",NEW."scopeRevision",NEW."channel",NEW."surface",
    NEW."targetDigest",NEW."payloadDigest",NEW."operation",NEW."effectKey",NEW."sourceHash",NEW."actorKind",NEW."actorId",NEW."createdAt") IS DISTINCT FROM
    ROW(OLD."id",OLD."endpointScopeId",OLD."scopeRevision",OLD."channel",OLD."surface",
    OLD."targetDigest",OLD."payloadDigest",OLD."operation",OLD."effectKey",OLD."sourceHash",OLD."actorKind",OLD."actorId",OLD."createdAt") OR OLD."status"<>'ADMITTED' THEN
    RAISE EXCEPTION 'legacy physical evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "CustomerLegacyPhysicalAttempt_immutable" BEFORE UPDATE OR DELETE
  ON "CustomerLegacyPhysicalAttempt" FOR EACH ROW EXECUTE FUNCTION customer_legacy_physical_immutable();
