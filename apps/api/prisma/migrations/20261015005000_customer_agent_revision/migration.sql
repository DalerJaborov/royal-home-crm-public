-- Additive immutable customer-core revisions. No registration, activation or budget changes.

CREATE TABLE "CustomerAgentRevision" (
  "id" TEXT NOT NULL,
  "manifestJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerAgentRevision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerAgentRevision_manifest_check" CHECK (
    "id" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("manifestJson")='object'
    AND NOT ("manifestJson" ? 'id')
  )
);
CREATE FUNCTION customer_agent_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id",NEW."manifestJson",NEW."createdAt") IS DISTINCT FROM
     ROW(OLD."id",OLD."manifestJson",OLD."createdAt") THEN
    RAISE EXCEPTION 'customer agent revision content is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_agent_revision_immutable BEFORE UPDATE ON "CustomerAgentRevision"
  FOR EACH ROW EXECUTE FUNCTION customer_agent_revision_immutable();

ALTER TABLE "CustomerRuntimePolicy" ADD COLUMN "activeAgentRevisionId" TEXT;
ALTER TABLE "CustomerRuntimePolicy" ADD CONSTRAINT "CustomerRuntimePolicy_activeAgentRevisionId_fkey"
  FOREIGN KEY ("activeAgentRevisionId") REFERENCES "CustomerAgentRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "CustomerPropertyIngressTicket"
  ADD COLUMN "agentRevisionId" TEXT,
  ADD COLUMN "providerOperationId" TEXT,
  ADD COLUMN "providerDeadlineAt" TIMESTAMP(3);
ALTER TABLE "CustomerPropertyIngressTicket" ADD CONSTRAINT "CustomerIngress_agent_pin_check" CHECK (
  ("agentRevisionId" IS NULL AND "providerOperationId" IS NULL AND "providerDeadlineAt" IS NULL)
  OR
  ("agentRevisionId" IS NOT NULL AND "providerOperationId" IS NOT NULL AND "providerDeadlineAt" IS NOT NULL
    AND "agentRevisionId" ~ '^[a-f0-9]{64}$'
    AND "providerOperationId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND "originVersion" IS NOT NULL AND "originVersion"=1
    AND "originCiphertext" IS NOT NULL AND "inputRecordedAt" IS NOT NULL
    AND "payloadVersion" IS NOT NULL AND "payloadVersion"=1
    AND "providerDeadlineAt">"receivedAt"
    AND "providerDeadlineAt"<="receivedAt"+interval '15 minutes')
);
ALTER TABLE "CustomerPropertyIngressTicket" ADD CONSTRAINT "CustomerPropertyIngressTicket_agentRevisionId_fkey"
  FOREIGN KEY ("agentRevisionId") REFERENCES "CustomerAgentRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
-- No providerOperation FK: the durable operation is created only by first
-- actual P13 reservation, not by merely pinning a turn.
CREATE FUNCTION customer_agent_ticket_pin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."agentRevisionId" IS NOT NULL AND
     ROW(NEW."agentRevisionId",NEW."providerOperationId",NEW."providerDeadlineAt") IS DISTINCT FROM
     ROW(OLD."agentRevisionId",OLD."providerOperationId",OLD."providerDeadlineAt") THEN
    RAISE EXCEPTION 'customer turn agent and provider pins cannot be renewed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_agent_ticket_pin_immutable BEFORE UPDATE ON "CustomerPropertyIngressTicket"
  FOR EACH ROW EXECUTE FUNCTION customer_agent_ticket_pin_immutable();

ALTER TABLE "CustomerOutboxPart" ADD COLUMN "agentRevisionId" TEXT;
ALTER TABLE "CustomerOutboxPart" ADD CONSTRAINT "CustomerOutboxPart_agentRevisionId_fkey"
  FOREIGN KEY ("agentRevisionId") REFERENCES "CustomerAgentRevision"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE FUNCTION customer_agent_outbox_pin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."agentRevisionId" IS DISTINCT FROM OLD."agentRevisionId" THEN
    RAISE EXCEPTION 'customer output agent pin cannot change';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_agent_outbox_pin_immutable BEFORE UPDATE ON "CustomerOutboxPart"
  FOR EACH ROW EXECUTE FUNCTION customer_agent_outbox_pin_immutable();

-- Intentionally no revision rows, no policy activation, no budget/config writes.
-- Root runtime must decode canonical manifest, verify actual source/prompt/tools/
-- knowledge/profile/policy hashes, refresh the genuine pin inside the SAME P12
-- planning transaction and copy its exact revision to newly inserted parts.
-- DB shape/FKs alone are not outbound authority or content-hash verification.
