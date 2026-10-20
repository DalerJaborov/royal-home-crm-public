-- Additive managed delivery/provider storage. No rollout, credential or budget
-- setting is enabled here. Historical NULL payloads are not replayable input.
ALTER TABLE "CustomerPropertyIngressTicket" DROP CONSTRAINT "CustomerPropertyIngressTicket_conversationId_fkey";
ALTER TABLE "CustomerPropertyIngressTicket" ALTER COLUMN "conversationId" DROP NOT NULL,
  ADD COLUMN "originalConversationId" TEXT, ADD COLUMN "tombstonedAt" TIMESTAMP(3),
  ADD COLUMN "eventKind" TEXT, ADD COLUMN "payloadVersion" INTEGER,
  ADD COLUMN "payloadCiphertext" TEXT, ADD COLUMN "payloadHash" TEXT,
  ADD COLUMN "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "providerOccurredAt" TIMESTAMP(3), ADD COLUMN "originVersion" INTEGER,
  ADD COLUMN "originCiphertext" TEXT, ADD COLUMN "originCapturedAt" TIMESTAMP(3),
  ADD COLUMN "processingState" TEXT, ADD COLUMN "claimRevision" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "leaseOwner" TEXT, ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3), ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "errorCode" TEXT, ADD COLUMN "turnKey" TEXT, ADD COLUMN "headEventKey" TEXT,
  ADD COLUMN "plannedAt" TIMESTAMP(3);
UPDATE "CustomerPropertyIngressTicket" SET "originalConversationId"="conversationId";
ALTER TABLE "CustomerPropertyIngressTicket" ADD CONSTRAINT "CustomerPropertyIngressTicket_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "BotConversation"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "CustomerPropertyIngressTicket" ADD CONSTRAINT "CustomerIngress_payload_check" CHECK
  (("payloadVersion" IS NULL AND "payloadCiphertext" IS NULL AND "payloadHash" IS NULL) OR
   ("payloadVersion" IS NOT NULL AND "payloadVersion"=1 AND "payloadCiphertext" IS NOT NULL AND "payloadHash" IS NOT NULL AND "payloadHash" ~ '^[a-f0-9]{64}$')),
  ADD CONSTRAINT "CustomerIngress_origin_check" CHECK
  (("originVersion" IS NULL AND "originCiphertext" IS NULL AND "originCapturedAt" IS NULL) OR
   ("originVersion" IS NOT NULL AND "originVersion"=1 AND "originCiphertext" IS NOT NULL AND "originCapturedAt" IS NOT NULL AND "payloadVersion" IS NOT NULL AND "payloadVersion"=1)),
  ADD CONSTRAINT "CustomerIngress_state_check" CHECK
  ("processingState" IS NULL OR ("payloadVersion" IS NOT NULL AND "processingState" IN
   ('RECEIVED','CLAIMED','PLANNED','IGNORED','HELD','FAILED'))),
  ADD CONSTRAINT "CustomerIngress_revision_check" CHECK ("claimRevision">=0 AND "attempts">=0),
  ADD CONSTRAINT "CustomerIngress_native_check" CHECK
  (("conversationId" IS NULL OR ("originalConversationId" IS NOT NULL AND "conversationId"="originalConversationId")) AND
   ("tombstonedAt" IS NULL OR ("conversationId" IS NULL AND "originalConversationId" IS NOT NULL)));
CREATE INDEX "CustomerPropertyIngressTicket_processingState_nextAttemptAt_le_idx"
  ON "CustomerPropertyIngressTicket"("processingState","nextAttemptAt","leaseUntil");

CREATE FUNCTION customer_ingress_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW."originalConversationId" IS NULL AND NEW."conversationId" IS NOT NULL THEN
      NEW."originalConversationId" := NEW."conversationId";
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW."eventKey",NEW."order",NEW."scopeKey",NEW."endpointScopeId",NEW."payloadVersion",NEW."payloadCiphertext",NEW."payloadHash",NEW."receivedAt",NEW."providerOccurredAt",NEW."eventKind") IS DISTINCT FROM
     ROW(OLD."eventKey",OLD."order",OLD."scopeKey",OLD."endpointScopeId",OLD."payloadVersion",OLD."payloadCiphertext",OLD."payloadHash",OLD."receivedAt",OLD."providerOccurredAt",OLD."eventKind") THEN
    RAISE EXCEPTION 'customer ingress identity and captured payload are immutable';
  END IF;
  IF OLD."originalConversationId" IS NOT NULL AND NEW."originalConversationId" IS DISTINCT FROM OLD."originalConversationId" THEN
    RAISE EXCEPTION 'customer ingress original native is immutable';
  END IF;
  IF OLD."conversationId" IS NOT NULL AND NEW."conversationId" IS NOT NULL AND NEW."conversationId" <> OLD."conversationId" THEN
    RAISE EXCEPTION 'customer ingress cannot change native';
  END IF;
  IF OLD."conversationId" IS NOT NULL AND NEW."conversationId" IS NULL THEN
    NEW."tombstonedAt" := COALESCE(OLD."tombstonedAt",CURRENT_TIMESTAMP);
  END IF;
  IF OLD."tombstonedAt" IS NOT NULL AND (NEW."conversationId" IS NOT NULL OR NEW."tombstonedAt" IS DISTINCT FROM OLD."tombstonedAt") THEN
    RAISE EXCEPTION 'customer ingress tombstone cannot be revived';
  END IF;
  IF OLD."originVersion" IS NOT NULL AND ROW(NEW."originVersion",NEW."originCiphertext",NEW."originCapturedAt") IS DISTINCT FROM
     ROW(OLD."originVersion",OLD."originCiphertext",OLD."originCapturedAt") THEN
    RAISE EXCEPTION 'customer ingress final origin is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_ingress_identity_immutable BEFORE INSERT OR UPDATE ON "CustomerPropertyIngressTicket"
  FOR EACH ROW EXECUTE FUNCTION customer_ingress_identity_immutable();

CREATE TABLE "CustomerOutboxPart" (
  "id" TEXT NOT NULL, "partKey" TEXT NOT NULL, "ticketEventKey" TEXT,
  "inquiryId" TEXT NOT NULL, "originalNativeId" TEXT NOT NULL, "conversationId" TEXT,
  "turnKey" TEXT NOT NULL, "ordinal" INTEGER NOT NULL, "mode" TEXT NOT NULL,
  "sourceKind" TEXT NOT NULL, "sourceKey" TEXT NOT NULL, "channel" TEXT NOT NULL,
  "endpointScopeId" TEXT NOT NULL, "transportJson" JSONB NOT NULL,
  "payloadEncrypted" TEXT NOT NULL, "payloadHash" TEXT NOT NULL, "payloadVersion" INTEGER NOT NULL,
  "fenceJson" JSONB NOT NULL, "p03Json" JSONB, "receiptRefsJson" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'READY', "claimRevision" BIGINT NOT NULL DEFAULT 0,
  "leaseOwner" TEXT, "leaseUntil" TIMESTAMP(3), "nextAttemptAt" TIMESTAMP(3),
  "acceptedAt" TIMESTAMP(3), "projectionRecordedAt" TIMESTAMP(3),
  "cancelRequestedAt" TIMESTAMP(3), "supersededAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerOutboxPart_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerOutboxPart_state_check" CHECK ("status" IN
    ('READY','IN_FLIGHT','ACCEPTED','AVAILABLE_WIDGET','NOT_SENT','UNKNOWN','SUPPRESSED')),
  CONSTRAINT "CustomerOutboxPart_mode_check" CHECK ("mode" IN ('LIVE','SHADOW') AND
    ("mode" <> 'SHADOW' OR "status" IN ('READY','SUPPRESSED'))),
  CONSTRAINT "CustomerOutboxPart_source_check" CHECK ("sourceKind" IN ('BOT_TURN','STAFF_ANSWER')),
  CONSTRAINT "CustomerOutboxPart_shape_check" CHECK ("ordinal">=0 AND "claimRevision">=0 AND
    "payloadVersion"=1 AND "payloadHash" ~ '^[a-f0-9]{64}$' AND
    ("conversationId" IS NULL OR "conversationId"="originalNativeId") AND
    jsonb_typeof("transportJson")='object' AND jsonb_typeof("fenceJson")='object' AND jsonb_typeof("receiptRefsJson")='array')
);
CREATE UNIQUE INDEX "CustomerOutboxPart_partKey_key" ON "CustomerOutboxPart"("partKey");
CREATE UNIQUE INDEX "CustomerOutboxPart_turnKey_ordinal_mode_key" ON "CustomerOutboxPart"("turnKey","ordinal","mode");
CREATE UNIQUE INDEX "CustomerOutboxPart_id_endpointScopeId_key" ON "CustomerOutboxPart"("id","endpointScopeId");
CREATE INDEX "CustomerOutboxPart_status_nextAttemptAt_leaseUntil_idx" ON "CustomerOutboxPart"("status","nextAttemptAt","leaseUntil");
CREATE INDEX "CustomerOutboxPart_conversationId_idx" ON "CustomerOutboxPart"("conversationId");
ALTER TABLE "CustomerOutboxPart" ADD CONSTRAINT "CustomerOutboxPart_ticketEventKey_fkey" FOREIGN KEY ("ticketEventKey") REFERENCES "CustomerPropertyIngressTicket"("eventKey") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerOutboxPart" ADD CONSTRAINT "CustomerOutboxPart_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "CustomerInquiry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerOutboxPart" ADD CONSTRAINT "CustomerOutboxPart_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "BotConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CustomerOutboxPart" ADD CONSTRAINT "CustomerOutboxPart_endpointScopeId_fkey" FOREIGN KEY ("endpointScopeId") REFERENCES "CustomerEndpointScope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "CustomerDeliveryAttempt" (
  "id" TEXT NOT NULL, "partId" TEXT NOT NULL, "endpointScopeId" TEXT NOT NULL,
  "attemptNo" INTEGER NOT NULL, "claimRevision" BIGINT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finishedAt" TIMESTAMP(3),
  "outcome" TEXT NOT NULL DEFAULT 'IN_FLIGHT', "providerMid" TEXT, "reportedMid" TEXT,
  "errorCode" TEXT, "dispatchFenceJson" JSONB NOT NULL,
  CONSTRAINT "CustomerDeliveryAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerDeliveryAttempt_state_check" CHECK ("outcome" IN ('IN_FLIGHT','NOT_SENT','ACCEPTED','REJECTED','UNKNOWN')),
  CONSTRAINT "CustomerDeliveryAttempt_shape_check" CHECK ("attemptNo">0 AND "claimRevision">=0 AND jsonb_typeof("dispatchFenceJson")='object'),
  CONSTRAINT "CustomerDeliveryAttempt_receipt_check" CHECK ("outcome"<>'ACCEPTED' OR ("providerMid" IS NOT NULL AND length("providerMid")>0))
);
CREATE UNIQUE INDEX "CustomerDeliveryAttempt_partId_attemptNo_key" ON "CustomerDeliveryAttempt"("partId","attemptNo");
CREATE INDEX "CustomerDeliveryAttempt_endpointScopeId_providerMid_idx" ON "CustomerDeliveryAttempt"("endpointScopeId","providerMid");
CREATE UNIQUE INDEX "CustomerDeliveryAttempt_provider_association_key" ON "CustomerDeliveryAttempt"("endpointScopeId","providerMid") WHERE "providerMid" IS NOT NULL;
ALTER TABLE "CustomerDeliveryAttempt" ADD CONSTRAINT "CustomerDeliveryAttempt_partId_endpointScopeId_fkey" FOREIGN KEY ("partId","endpointScopeId") REFERENCES "CustomerOutboxPart"("id","endpointScopeId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerDeliveryAttempt" ADD CONSTRAINT "CustomerDeliveryAttempt_endpointScopeId_fkey" FOREIGN KEY ("endpointScopeId") REFERENCES "CustomerEndpointScope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION customer_delivery_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='CustomerOutboxPart' THEN
    IF ROW(NEW."partKey",NEW."ticketEventKey",NEW."inquiryId",NEW."originalNativeId",NEW."turnKey",NEW."ordinal",NEW."mode",NEW."sourceKind",NEW."sourceKey",NEW."channel",NEW."endpointScopeId",NEW."transportJson",NEW."payloadEncrypted",NEW."payloadHash",NEW."payloadVersion",NEW."fenceJson",NEW."p03Json",NEW."receiptRefsJson") IS DISTINCT FROM
       ROW(OLD."partKey",OLD."ticketEventKey",OLD."inquiryId",OLD."originalNativeId",OLD."turnKey",OLD."ordinal",OLD."mode",OLD."sourceKind",OLD."sourceKey",OLD."channel",OLD."endpointScopeId",OLD."transportJson",OLD."payloadEncrypted",OLD."payloadHash",OLD."payloadVersion",OLD."fenceJson",OLD."p03Json",OLD."receiptRefsJson") OR
       (OLD."conversationId" IS NULL AND NEW."conversationId" IS NOT NULL) OR
       (OLD."conversationId" IS NOT NULL AND NEW."conversationId" IS NOT NULL AND OLD."conversationId"<>NEW."conversationId") THEN
      RAISE EXCEPTION 'customer outbox original target and payload are immutable';
    END IF;
  ELSE
    IF ROW(NEW."partId",NEW."endpointScopeId",NEW."attemptNo",NEW."claimRevision",NEW."startedAt",NEW."dispatchFenceJson") IS DISTINCT FROM
       ROW(OLD."partId",OLD."endpointScopeId",OLD."attemptNo",OLD."claimRevision",OLD."startedAt",OLD."dispatchFenceJson") OR
       (OLD."providerMid" IS NOT NULL AND NEW."providerMid" IS DISTINCT FROM OLD."providerMid") THEN
      RAISE EXCEPTION 'customer delivery attempt identity and associated MID are immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_outbox_identity_immutable BEFORE UPDATE ON "CustomerOutboxPart" FOR EACH ROW EXECUTE FUNCTION customer_delivery_identity_immutable();
CREATE TRIGGER customer_delivery_attempt_identity_immutable BEFORE UPDATE ON "CustomerDeliveryAttempt" FOR EACH ROW EXECUTE FUNCTION customer_delivery_identity_immutable();

CREATE TABLE "AiProviderDailyBudget" (
  "id" TEXT NOT NULL, "policyKey" TEXT NOT NULL, "dayKey" TEXT NOT NULL,
  "capUsd" DECIMAL(18,9), "reservedUsd" DECIMAL(18,9) NOT NULL DEFAULT 0, "settledUsd" DECIMAL(18,9) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiProviderDailyBudget_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiProviderDailyBudget_nonnegative_check" CHECK (("capUsd" IS NULL OR "capUsd">=0) AND "reservedUsd">=0 AND "settledUsd">=0)
);
CREATE UNIQUE INDEX "AiProviderDailyBudget_policyKey_dayKey_key" ON "AiProviderDailyBudget"("policyKey","dayKey");
CREATE TABLE "AiProviderOperation" (
  "id" TEXT NOT NULL, "policyKey" TEXT NOT NULL, "policyHash" TEXT NOT NULL, "dayKey" TEXT NOT NULL,
  "deadlineAt" TIMESTAMP(3) NOT NULL, "maxAttempts" INTEGER NOT NULL,
  "attemptsReserved" INTEGER NOT NULL DEFAULT 0, "maxCostUsd" DECIMAL(18,9),
  "reservedUsd" DECIMAL(18,9) NOT NULL DEFAULT 0, "settledUsd" DECIMAL(18,9) NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'OPEN', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "AiProviderOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiProviderOperation_bounds_check" CHECK ("maxAttempts">0 AND "attemptsReserved">=0 AND "attemptsReserved"<="maxAttempts" AND
    ("maxCostUsd" IS NULL OR "maxCostUsd">=0) AND "reservedUsd">=0 AND "settledUsd">=0 AND "policyHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "AiProviderOperation_status_check" CHECK ("status" IN ('OPEN','CLOSED','HELD'))
);
CREATE INDEX "AiProviderOperation_policyKey_dayKey_idx" ON "AiProviderOperation"("policyKey","dayKey");
CREATE INDEX "AiProviderOperation_status_deadlineAt_idx" ON "AiProviderOperation"("status","deadlineAt");
ALTER TABLE "AiLog" ADD COLUMN "operationId" TEXT, ADD COLUMN "attemptNo" INTEGER,
  ADD COLUMN "provider" TEXT, ADD COLUMN "api" TEXT, ADD COLUMN "profileRevision" TEXT,
  ADD COLUMN "pricingRevision" TEXT, ADD COLUMN "attemptState" TEXT, ADD COLUMN "usageSource" TEXT,
  ADD COLUMN "usageCompleteness" TEXT, ADD COLUMN "costStatus" TEXT, ADD COLUMN "thinkingTokens" INTEGER,
  ADD COLUMN "audioInputTokens" INTEGER, ADD COLUMN "audioOutputTokens" INTEGER,
  ADD COLUMN "searchUnits" INTEGER, ADD COLUMN "reservedUsd" DECIMAL(18,9), ADD COLUMN "settledUsd" DECIMAL(18,9);
CREATE UNIQUE INDEX "AiLog_operationId_attemptNo_key" ON "AiLog"("operationId","attemptNo");
ALTER TABLE "AiLog" ADD CONSTRAINT "AiLog_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "AiProviderOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiLog" ADD CONSTRAINT "AiLog_managed_attempt_check" CHECK
  ("operationId" IS NULL OR ("attemptNo" IS NOT NULL AND "attemptNo">0 AND "reservedUsd" IS NOT NULL AND "reservedUsd">=0 AND
    "attemptState" IS NOT NULL AND "attemptState" IN ('RESERVED','STARTED','SETTLED','UNKNOWN') AND
    ("attemptState"<>'SETTLED' OR ("settledUsd" IS NOT NULL AND "settledUsd">=0))));

CREATE FUNCTION ai_provider_operation_policy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."policyKey",NEW."policyHash",NEW."dayKey",NEW."deadlineAt",NEW."maxAttempts",NEW."maxCostUsd") IS DISTINCT FROM
     ROW(OLD."policyKey",OLD."policyHash",OLD."dayKey",OLD."deadlineAt",OLD."maxAttempts",OLD."maxCostUsd") THEN
    RAISE EXCEPTION 'managed provider operation policy cannot be renewed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_provider_operation_policy_immutable BEFORE UPDATE ON "AiProviderOperation" FOR EACH ROW EXECUTE FUNCTION ai_provider_operation_policy_immutable();
