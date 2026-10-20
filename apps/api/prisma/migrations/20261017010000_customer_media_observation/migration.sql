-- 520 after the combined R3 release: preserve real media understanding without
-- plaintext transcripts or rewriting original payload/hash, pins or receipts.
BEGIN;
ALTER TABLE "CustomerPropertyIngressTicket"
  ADD COLUMN "mediaObservationVersion" INTEGER,
  ADD COLUMN "mediaObservationCiphertext" TEXT,
  ADD COLUMN "mediaObservedAt" TIMESTAMP(3),
  ADD CONSTRAINT "customer_media_observation_shape" CHECK (
    ("mediaObservationVersion" IS NULL AND "mediaObservationCiphertext" IS NULL AND "mediaObservedAt" IS NULL) OR
    ("mediaObservationVersion" IS NOT NULL AND "mediaObservationVersion"=1 AND "mediaObservationCiphertext" IS NOT NULL AND length("mediaObservationCiphertext") BETWEEN 1 AND 80000 AND "mediaObservedAt" IS NOT NULL));
CREATE FUNCTION customer_media_observation_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW."mediaObservationVersion" IS NOT NULL THEN RAISE EXCEPTION 'Media observation requires original claimed turn'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW."mediaObservationVersion",NEW."mediaObservationCiphertext",NEW."mediaObservedAt") IS NOT DISTINCT FROM
     ROW(OLD."mediaObservationVersion",OLD."mediaObservationCiphertext",OLD."mediaObservedAt") THEN RETURN NEW; END IF;
  IF OLD."mediaObservationVersion" IS NOT NULL OR OLD."processingState" IS DISTINCT FROM 'CLAIMED' OR
    NEW."processingState" IS DISTINCT FROM 'CLAIMED' OR NEW."leaseOwner" IS DISTINCT FROM OLD."leaseOwner" OR
    OLD."leaseOwner" IS NULL OR NEW."claimRevision" IS DISTINCT FROM OLD."claimRevision" OR NEW."leaseUntil" IS NULL OR
    NEW."leaseUntil"<=clock_timestamp() OR NEW."tombstonedAt" IS NOT NULL OR
    NEW."agentRevisionId" IS NULL OR NEW."providerOperationId" IS NULL OR NEW."payloadHash" IS NULL OR
    NEW."mediaObservedAt"<NEW."receivedAt" OR NEW."mediaObservedAt">clock_timestamp() OR
    NOT EXISTS(SELECT 1 FROM "AiLog" WHERE "operationId"=NEW."providerOperationId" AND "providerOutcome"='success') THEN
    RAISE EXCEPTION 'Immutable media observation or original context unavailable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_media_observation_write BEFORE INSERT OR UPDATE ON "CustomerPropertyIngressTicket"
  FOR EACH ROW EXECUTE FUNCTION customer_media_observation_write();
COMMIT;
