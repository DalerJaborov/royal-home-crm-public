-- Gate A: additive expand only. All legacy unique indexes remain in force.
-- Contract cutover/drop of old indexes requires a separate verified release.
CREATE TABLE "CustomerEndpointScope" (
  "id" TEXT NOT NULL, "realmKey" TEXT NOT NULL, "channel" TEXT NOT NULL,
  "transportKey" TEXT NOT NULL, "kind" TEXT NOT NULL DEFAULT 'LEGACY_UNKNOWN',
  "messengerAccountId" TEXT, "scopeRevision" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerEndpointScope_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerEndpointScope_kind_check" CHECK ("kind" IN ('NORMAL','LEGACY_UNKNOWN')),
  CONSTRAINT "CustomerEndpointScope_revision_check" CHECK ("scopeRevision" >= 0),
  CONSTRAINT "CustomerEndpointScope_keys_check" CHECK (length("realmKey") BETWEEN 1 AND 128 AND
    length("channel") BETWEEN 1 AND 128 AND length("transportKey") BETWEEN 1 AND 512)
);
CREATE UNIQUE INDEX "CustomerEndpointScope_realmKey_channel_transportKey_key" ON "CustomerEndpointScope"("realmKey","channel","transportKey");
CREATE INDEX "CustomerEndpointScope_messengerAccountId_idx" ON "CustomerEndpointScope"("messengerAccountId");
ALTER TABLE "CustomerEndpointScope" ADD CONSTRAINT "CustomerEndpointScope_messengerAccountId_fkey"
  FOREIGN KEY ("messengerAccountId") REFERENCES "MessengerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CustomerRuntimePolicy" (
  "id" TEXT NOT NULL DEFAULT 'singleton', "policyRevision" BIGINT NOT NULL DEFAULT 0,
  "contractVersion" TEXT NOT NULL DEFAULT 'compat', "rolloutMode" TEXT NOT NULL DEFAULT 'OFF',
  "capabilities" JSONB NOT NULL DEFAULT '{}', "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerRuntimePolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerRuntimePolicy_revision_check" CHECK ("policyRevision" >= 0),
  CONSTRAINT "CustomerRuntimePolicy_singleton_check" CHECK ("id" = 'singleton'),
  CONSTRAINT "CustomerRuntimePolicy_mode_check" CHECK ("contractVersion" IN ('compat','scoped') AND "rolloutMode" IN ('OFF','SHADOW','ACTIVE')),
  CONSTRAINT "CustomerRuntimePolicy_caps_check" CHECK (jsonb_typeof("capabilities") = 'object')
);
INSERT INTO "CustomerRuntimePolicy" ("id","updatedAt") VALUES ('singleton',now());

CREATE TABLE "CustomerInquiry" (
  "id" TEXT NOT NULL, "endpointScopeId" TEXT NOT NULL, "peerId" TEXT NOT NULL, "threadId" TEXT NOT NULL DEFAULT '',
  "conversationId" TEXT, "telegramConversationId" TEXT, "telegramDirectConversationId" TEXT,
  "stateRevision" BIGINT NOT NULL DEFAULT 0, "intentRevision" BIGINT NOT NULL DEFAULT 0,
  "ownershipEpoch" BIGINT NOT NULL DEFAULT 0, "bindingRevision" BIGINT NOT NULL DEFAULT 0,
  "ownerMode" TEXT NOT NULL DEFAULT 'HOLD', "ownerAgentId" TEXT, "ownerToken" TEXT, "ownerLeaseUntil" TIMESTAMP(3),
  "migrationVersion" INTEGER NOT NULL DEFAULT 1, "closedAt" TIMESTAMP(3), "publicState" JSONB NOT NULL DEFAULT '{}',
  "claimedContact" JSONB, "actionIntents" JSONB NOT NULL DEFAULT '{}',
  "lastAcceptedEventKey" TEXT, "lastAcceptedOrder" BIGINT, "legacyMemoryQuarantined" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerInquiry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerInquiry_native_check" CHECK (num_nonnulls("conversationId","telegramConversationId","telegramDirectConversationId") <= 1),
  CONSTRAINT "CustomerInquiry_revision_check" CHECK ("stateRevision" >= 0 AND "intentRevision" >= 0 AND "ownershipEpoch" >= 0 AND "bindingRevision" >= 0),
  CONSTRAINT "CustomerInquiry_owner_check" CHECK ("ownerMode" IN ('BOT','HUMAN','OFF','HOLD') AND ("ownerMode" = 'HUMAN') = ("ownerAgentId" IS NOT NULL)),
  CONSTRAINT "CustomerInquiry_slots_check" CHECK (jsonb_typeof("publicState") = 'object' AND jsonb_typeof("actionIntents") = 'object' AND
    ("claimedContact" IS NULL OR jsonb_typeof("claimedContact") = 'object')),
  CONSTRAINT "CustomerInquiry_keys_check" CHECK (length("peerId") BETWEEN 1 AND 512 AND length("threadId") <= 512)
);
CREATE UNIQUE INDEX "CustomerInquiry_endpointScopeId_peerId_threadId_key" ON "CustomerInquiry"("endpointScopeId","peerId","threadId");
CREATE UNIQUE INDEX "CustomerInquiry_conversationId_key" ON "CustomerInquiry"("conversationId");
CREATE UNIQUE INDEX "CustomerInquiry_telegramConversationId_key" ON "CustomerInquiry"("telegramConversationId");
CREATE UNIQUE INDEX "CustomerInquiry_telegramDirectConversationId_key" ON "CustomerInquiry"("telegramDirectConversationId");
CREATE INDEX "CustomerInquiry_closedAt_ownerMode_idx" ON "CustomerInquiry"("closedAt","ownerMode");
ALTER TABLE "CustomerInquiry" ADD CONSTRAINT "CustomerInquiry_endpointScopeId_fkey" FOREIGN KEY ("endpointScopeId") REFERENCES "CustomerEndpointScope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerInquiry" ADD CONSTRAINT "CustomerInquiry_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "BotConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CustomerInquiry" ADD CONSTRAINT "CustomerInquiry_telegramConversationId_fkey" FOREIGN KEY ("telegramConversationId") REFERENCES "TelegramConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CustomerInquiry" ADD CONSTRAINT "CustomerInquiry_telegramDirectConversationId_fkey" FOREIGN KEY ("telegramDirectConversationId") REFERENCES "TelegramDirectConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CustomerAction" (
  "id" TEXT NOT NULL, "inquiryId" TEXT NOT NULL, "kind" TEXT NOT NULL, "generation" BIGINT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PROPOSED', "stateRevision" BIGINT NOT NULL, "intentRevision" BIGINT NOT NULL,
  "ownershipEpoch" BIGINT NOT NULL, "bindingRevision" BIGINT NOT NULL, "scopeRevision" BIGINT NOT NULL, "policyRevision" BIGINT NOT NULL,
  "evidenceRefs" JSONB NOT NULL, "resourceType" TEXT, "resourceId" TEXT, "receiptVersion" INTEGER,
  "committedAt" TIMESTAMP(3), "supersededAt" TIMESTAMP(3), "failureCode" TEXT, "policyResult" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomerAction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerAction_kind_check" CHECK ("kind" IN ('contact','callback','new_lead')),
  CONSTRAINT "CustomerAction_status_check" CHECK ("status" IN ('PROPOSED','EXECUTING','COMMITTED','FAILED','UNKNOWN')),
  CONSTRAINT "CustomerAction_revision_check" CHECK ("generation" > 0 AND "stateRevision" >= 0 AND "intentRevision" >= 0 AND "ownershipEpoch" >= 0 AND "bindingRevision" >= 0 AND "scopeRevision" >= 0 AND "policyRevision" >= 0),
  CONSTRAINT "CustomerAction_evidence_check" CHECK (jsonb_typeof("evidenceRefs") = 'array' AND jsonb_array_length("evidenceRefs") BETWEEN 1 AND 16),
  CONSTRAINT "CustomerAction_committed_check" CHECK ("status" <> 'COMMITTED' OR
    ("receiptVersion" IS NOT NULL AND "receiptVersion" = 1 AND "committedAt" IS NOT NULL AND "resourceType" IS NOT NULL AND "resourceId" IS NOT NULL AND length("resourceId") > 0 AND
      (("kind" = 'contact' AND "resourceType" = 'CustomerInquiry' AND "resourceId" = "inquiryId") OR
       ("kind" = 'callback' AND "resourceType" = 'CallbackRequest') OR ("kind" = 'new_lead' AND "resourceType" = 'Client')))),
  CONSTRAINT "CustomerAction_failure_check" CHECK ("failureCode" IS NULL OR length("failureCode") <= 128)
);
CREATE UNIQUE INDEX "CustomerAction_inquiryId_kind_generation_key" ON "CustomerAction"("inquiryId","kind","generation");
CREATE INDEX "CustomerAction_inquiryId_createdAt_idx" ON "CustomerAction"("inquiryId","createdAt");
ALTER TABLE "CustomerAction" ADD CONSTRAINT "CustomerAction_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "CustomerInquiry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BotConversation" ADD COLUMN "endpointScopeId" TEXT;
ALTER TABLE "TelegramConversation" ADD COLUMN "endpointScopeId" TEXT;
ALTER TABLE "TelegramDirectConversation" ADD COLUMN "endpointScopeId" TEXT;
ALTER TABLE "OutboundShieldState" ADD COLUMN "endpointScopeId" TEXT;
ALTER TABLE "OutboundShieldState" ADD COLUMN "pauseFence" JSONB;
ALTER TABLE "LiveVoiceSession" ADD COLUMN "customerInquiryId" TEXT;
ALTER TABLE "Client" ADD COLUMN "customerIntakeActionId" TEXT;
ALTER TABLE "CallbackRequest" ADD COLUMN "customerActionId" TEXT;
-- Existing tickets keep NULL: routing backfill is not historical IN authority.
ALTER TABLE "CustomerPropertyIngressTicket" ADD COLUMN "endpointScopeId" TEXT;
CREATE INDEX "CustomerPropertyIngressTicket_endpointScopeId_idx" ON "CustomerPropertyIngressTicket"("endpointScopeId");
ALTER TABLE "CustomerPropertyIngressTicket" ADD CONSTRAINT "CustomerPropertyIngressTicket_endpointScopeId_fkey"
  FOREIGN KEY ("endpointScopeId") REFERENCES "CustomerEndpointScope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Old exposure/showcase rows have no account provenance. Deliberately leave NULL.
ALTER TABLE "PropertyExposure" ADD COLUMN "endpointScopeId" TEXT;
ALTER TABLE "ShownProperty" ADD COLUMN "endpointScopeId" TEXT;
CREATE INDEX "PropertyExposure_endpointScopeId_recipientId_sentAt_idx" ON "PropertyExposure"("endpointScopeId","recipientId","sentAt");
CREATE UNIQUE INDEX "ShownProperty_endpointScopeId_recipientId_shortId_key" ON "ShownProperty"("endpointScopeId","recipientId","shortId");
ALTER TABLE "PropertyExposure" ADD CONSTRAINT "PropertyExposure_endpointScopeId_fkey" FOREIGN KEY ("endpointScopeId") REFERENCES "CustomerEndpointScope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShownProperty" ADD CONSTRAINT "ShownProperty_endpointScopeId_fkey" FOREIGN KEY ("endpointScopeId") REFERENCES "CustomerEndpointScope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "BotConversation_endpointScopeId_subscriberId_key" ON "BotConversation"("endpointScopeId","subscriberId");
CREATE INDEX "TelegramConversation_endpointScopeId_idx" ON "TelegramConversation"("endpointScopeId");
CREATE UNIQUE INDEX "TelegramDirectConversation_endpointScopeId_chatId_topicId_key" ON "TelegramDirectConversation"("endpointScopeId","chatId","topicId");
CREATE UNIQUE INDEX "OutboundShieldState_endpointScopeId_subscriberId_key" ON "OutboundShieldState"("endpointScopeId","subscriberId");
CREATE UNIQUE INDEX "Client_customerIntakeActionId_key" ON "Client"("customerIntakeActionId");
CREATE UNIQUE INDEX "CallbackRequest_customerActionId_key" ON "CallbackRequest"("customerActionId");
ALTER TABLE "BotConversation" ADD CONSTRAINT "BotConversation_endpointScopeId_fkey" FOREIGN KEY ("endpointScopeId") REFERENCES "CustomerEndpointScope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TelegramConversation" ADD CONSTRAINT "TelegramConversation_endpointScopeId_fkey" FOREIGN KEY ("endpointScopeId") REFERENCES "CustomerEndpointScope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TelegramDirectConversation" ADD CONSTRAINT "TelegramDirectConversation_endpointScopeId_fkey" FOREIGN KEY ("endpointScopeId") REFERENCES "CustomerEndpointScope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OutboundShieldState" ADD CONSTRAINT "OutboundShieldState_endpointScopeId_fkey" FOREIGN KEY ("endpointScopeId") REFERENCES "CustomerEndpointScope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LiveVoiceSession" ADD CONSTRAINT "LiveVoiceSession_customerInquiryId_fkey" FOREIGN KEY ("customerInquiryId") REFERENCES "CustomerInquiry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Client" ADD CONSTRAINT "Client_customerIntakeActionId_fkey" FOREIGN KEY ("customerIntakeActionId") REFERENCES "CustomerAction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CallbackRequest" ADD CONSTRAINT "CallbackRequest_customerActionId_fkey" FOREIGN KEY ("customerActionId") REFERENCES "CustomerAction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DB-configured legacy WA/FB is an installation namespace, not an inferred
-- customer account. Presence alone grants routing only; fresh HMAC validation
-- still checks real encrypted credentials. Env-only fallback never backfills.
CREATE FUNCTION customer_db_installed_transport(business_channel text) RETURNS text LANGUAGE sql STABLE AS $$
  WITH installed AS (
    SELECT CASE WHEN business_channel='WHATSAPP' THEN "metaWaPhoneId" ELSE "metaPageId" END AS external_id,
      CASE WHEN business_channel='WHATSAPP' THEN "metaWaToken" ELSE "metaPageToken" END AS token,
      "metaAppSecret" AS secret FROM "Settings" WHERE "id"='singleton'
  ) SELECT 'settings:'||business_channel||':'||external_id FROM installed
    WHERE business_channel IN ('WHATSAPP','FACEBOOK') AND length(external_id) BETWEEN 1 AND 128
      AND length(token)>0 AND length(secret)>0 AND NOT EXISTS (
        SELECT 1 FROM "MessengerAccount" a WHERE a."channel"=business_channel AND
          (a."externalId"=external_id OR a."messagingId"=external_id OR external_id=ANY(a."extraExternalIds"))
      )
$$;

-- Exact installed account namespace only. No default-account guess for a null Meta binding.
INSERT INTO "CustomerEndpointScope" ("id","realmKey","channel","transportKey","kind","messengerAccountId","updatedAt")
  SELECT gen_random_uuid()::text,'royal-home',a."channel",'messenger-account:'||a."id",'NORMAL',a."id",now()
  FROM "MessengerAccount" a WHERE a."channel" IN ('INSTAGRAM','FACEBOOK','WHATSAPP');
INSERT INTO "CustomerEndpointScope" ("id","realmKey","channel","transportKey","kind","updatedAt")
  VALUES (gen_random_uuid()::text,'royal-home','WEBSITE','website-public-chat','NORMAL',now());
INSERT INTO "CustomerEndpointScope" ("id","realmKey","channel","transportKey","kind","updatedAt")
  SELECT gen_random_uuid()::text,'royal-home',channel,transport_key,'NORMAL',now()
    FROM (SELECT channel,customer_db_installed_transport(channel) AS transport_key
      FROM (VALUES ('WHATSAPP'),('FACEBOOK')) channels(channel)) installed WHERE transport_key IS NOT NULL;
INSERT INTO "CustomerEndpointScope" ("id","realmKey","channel","transportKey","kind","updatedAt")
  SELECT gen_random_uuid()::text,'royal-home',channel,key,'LEGACY_UNKNOWN',now() FROM (
    SELECT DISTINCT "channel" AS channel,'legacy-bot:'||"channel" AS key FROM "BotConversation"
    UNION SELECT 'TELEGRAM','legacy-telegram-bot'
    UNION SELECT 'TELEGRAM','legacy-telegram-direct'
  ) unknowns;
UPDATE "BotConversation" c SET "endpointScopeId" = s."id" FROM "CustomerEndpointScope" s
  WHERE s."realmKey"='royal-home' AND s."channel"=c."channel" AND
    ((c."channel"='WEBSITE' AND c."accountId" IS NULL AND s."transportKey"='website-public-chat') OR
     (c."accountId" IS NULL AND c."channel" IN ('WHATSAPP','FACEBOOK') AND
       s."transportKey"=customer_db_installed_transport(c."channel")) OR
     (c."accountId" IS NOT NULL AND s."messengerAccountId"=c."accountId"));
UPDATE "BotConversation" c SET "endpointScopeId"=s."id" FROM "CustomerEndpointScope" s
  WHERE c."endpointScopeId" IS NULL AND s."transportKey"='legacy-bot:'||c."channel" AND s."realmKey"='royal-home';
UPDATE "TelegramConversation" c SET "endpointScopeId"=s."id" FROM "CustomerEndpointScope" s WHERE s."realmKey"='royal-home' AND s."transportKey"='legacy-telegram-bot';
UPDATE "TelegramDirectConversation" c SET "endpointScopeId"=s."id" FROM "CustomerEndpointScope" s WHERE s."realmKey"='royal-home' AND s."transportKey"='legacy-telegram-direct';
-- Preserve shield counters/pauses only through ONE exact already-scoped native
-- NORMAL mapping. This is routing/safety continuity, not customer identity.
-- TG and unmapped/ambiguous Meta remain NULL; no generic Meta NULL fallback.
WITH exact_native AS (
  SELECT h."id",min(c."endpointScopeId") AS scope_id FROM "OutboundShieldState" h
    JOIN "BotConversation" c ON c."channel"=h."channel" AND c."subscriberId"=h."subscriberId"
    JOIN "CustomerEndpointScope" s ON s."id"=c."endpointScopeId" AND s."kind"='NORMAL'
      AND s."channel"=c."channel" AND s."messengerAccountId" IS NOT DISTINCT FROM c."accountId"
    WHERE h."channel" IN ('WHATSAPP','INSTAGRAM','FACEBOOK','WEBSITE')
    GROUP BY h."id" HAVING count(DISTINCT c."endpointScopeId")=1
) UPDATE "OutboundShieldState" h SET "endpointScopeId"=n.scope_id FROM exact_native n WHERE n."id"=h."id";
INSERT INTO "CustomerInquiry" ("id","endpointScopeId","peerId","conversationId","updatedAt")
  SELECT gen_random_uuid()::text,"endpointScopeId","subscriberId","id",now() FROM "BotConversation" WHERE length("subscriberId") BETWEEN 1 AND 512;
INSERT INTO "CustomerInquiry" ("id","endpointScopeId","peerId","telegramConversationId","updatedAt")
  SELECT gen_random_uuid()::text,"endpointScopeId","chatId","id",now() FROM "TelegramConversation" WHERE length("chatId") BETWEEN 1 AND 512;
INSERT INTO "CustomerInquiry" ("id","endpointScopeId","peerId","threadId","telegramDirectConversationId","updatedAt")
  SELECT gen_random_uuid()::text,"endpointScopeId","chatId","topicId","id",now() FROM "TelegramDirectConversation" WHERE length("chatId") BETWEEN 1 AND 512 AND length("topicId") <= 512;

-- Backstops cover raw SQL/legacy writes too. Explicit reducer increments are not doubled.
CREATE FUNCTION customer_inquiry_revisions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed boolean := false; intent_changed boolean := false; owner_changed boolean := false; binding_changed boolean := false;
BEGIN
  IF NEW."stateRevision" < OLD."stateRevision" OR NEW."intentRevision" < OLD."intentRevision" OR
     NEW."ownershipEpoch" < OLD."ownershipEpoch" OR NEW."bindingRevision" < OLD."bindingRevision" THEN
    RAISE EXCEPTION 'customer revision cannot decrease';
  END IF;
  -- Native deletion is a durable tombstone, never cascade-delete of business journal.
  IF (OLD."conversationId" IS NOT NULL AND NEW."conversationId" IS NULL) OR
     (OLD."telegramConversationId" IS NOT NULL AND NEW."telegramConversationId" IS NULL) OR
     (OLD."telegramDirectConversationId" IS NOT NULL AND NEW."telegramDirectConversationId" IS NULL) THEN
    NEW."closedAt" := COALESCE(NEW."closedAt",now()); NEW."ownerMode" := 'HOLD';
    NEW."ownerAgentId" := NULL; NEW."ownerToken" := NULL; NEW."ownerLeaseUntil" := NULL;
  END IF;
  binding_changed := ROW(NEW."endpointScopeId",NEW."peerId",NEW."threadId",NEW."conversationId",NEW."telegramConversationId",NEW."telegramDirectConversationId",NEW."closedAt")
    IS DISTINCT FROM ROW(OLD."endpointScopeId",OLD."peerId",OLD."threadId",OLD."conversationId",OLD."telegramConversationId",OLD."telegramDirectConversationId",OLD."closedAt");
  owner_changed := ROW(NEW."ownerMode",NEW."ownerAgentId",NEW."ownerToken",NEW."ownerLeaseUntil") IS DISTINCT FROM ROW(OLD."ownerMode",OLD."ownerAgentId",OLD."ownerToken",OLD."ownerLeaseUntil");
  -- Commit status alone is not a new intent. New/correct/cancel generation is.
  intent_changed := ROW(NEW."actionIntents"->'contact'->>'generation',NEW."actionIntents"->'callback'->>'generation')
    IS DISTINCT FROM ROW(OLD."actionIntents"->'contact'->>'generation',OLD."actionIntents"->'callback'->>'generation');
  changed := binding_changed OR owner_changed OR intent_changed OR
    ROW(NEW."publicState",NEW."claimedContact",NEW."actionIntents",NEW."lastAcceptedEventKey",NEW."lastAcceptedOrder",NEW."legacyMemoryQuarantined",NEW."migrationVersion")
    IS DISTINCT FROM ROW(OLD."publicState",OLD."claimedContact",OLD."actionIntents",OLD."lastAcceptedEventKey",OLD."lastAcceptedOrder",OLD."legacyMemoryQuarantined",OLD."migrationVersion");
  IF binding_changed THEN NEW."bindingRevision" := GREATEST(NEW."bindingRevision",OLD."bindingRevision"+1); END IF;
  IF owner_changed THEN NEW."ownershipEpoch" := GREATEST(NEW."ownershipEpoch",OLD."ownershipEpoch"+1); END IF;
  IF intent_changed THEN NEW."intentRevision" := GREATEST(NEW."intentRevision",OLD."intentRevision"+1); END IF;
  IF changed THEN NEW."stateRevision" := GREATEST(NEW."stateRevision",OLD."stateRevision"+1); NEW."updatedAt" := now(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_inquiry_revisions BEFORE UPDATE ON "CustomerInquiry" FOR EACH ROW EXECUTE FUNCTION customer_inquiry_revisions();

CREATE FUNCTION customer_scope_revisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."scopeRevision" < OLD."scopeRevision" THEN RAISE EXCEPTION 'customer scope revision cannot decrease'; END IF;
  IF OLD."messengerAccountId" IS NOT NULL AND NEW."messengerAccountId" IS NULL THEN NEW."kind" := 'LEGACY_UNKNOWN'; END IF;
  IF ROW(NEW."realmKey",NEW."channel",NEW."transportKey",NEW."kind",NEW."messengerAccountId") IS DISTINCT FROM
     ROW(OLD."realmKey",OLD."channel",OLD."transportKey",OLD."kind",OLD."messengerAccountId") THEN
    NEW."scopeRevision" := GREATEST(NEW."scopeRevision",OLD."scopeRevision"+1); NEW."updatedAt" := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_scope_revisions BEFORE UPDATE ON "CustomerEndpointScope" FOR EACH ROW EXECUTE FUNCTION customer_scope_revisions();

CREATE FUNCTION customer_policy_revisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."policyRevision" < OLD."policyRevision" THEN RAISE EXCEPTION 'customer policy revision cannot decrease'; END IF;
  IF ROW(NEW."contractVersion",NEW."rolloutMode",NEW."capabilities") IS DISTINCT FROM ROW(OLD."contractVersion",OLD."rolloutMode",OLD."capabilities") THEN
    NEW."policyRevision" := GREATEST(NEW."policyRevision",OLD."policyRevision"+1); NEW."updatedAt" := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_policy_revisions BEFORE UPDATE ON "CustomerRuntimePolicy" FOR EACH ROW EXECUTE FUNCTION customer_policy_revisions();

CREATE FUNCTION customer_native_revisions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE oldrow jsonb := to_jsonb(OLD); newrow jsonb := to_jsonb(NEW); anchor text;
  binding_changed boolean; owner_changed boolean; focus_changed boolean;
BEGIN
  anchor := CASE TG_TABLE_NAME WHEN 'BotConversation' THEN 'conversationId' WHEN 'TelegramConversation' THEN 'telegramConversationId' ELSE 'telegramDirectConversationId' END;
  binding_changed := ROW(newrow->'endpointScopeId',newrow->'channel',newrow->'subscriberId',newrow->'accountId',newrow->'chatId',newrow->'topicId',newrow->'clientId',newrow->'contactProfileId')
    IS DISTINCT FROM ROW(oldrow->'endpointScopeId',oldrow->'channel',oldrow->'subscriberId',oldrow->'accountId',oldrow->'chatId',oldrow->'topicId',oldrow->'clientId',oldrow->'contactProfileId');
  owner_changed := ROW(newrow->'pausedUntil',newrow->'botPausedAt',newrow->'propertyChatAgentId',newrow->'propertyChatAgentAt',newrow->'optedOutAt')
    IS DISTINCT FROM ROW(oldrow->'pausedUntil',oldrow->'botPausedAt',oldrow->'propertyChatAgentId',oldrow->'propertyChatAgentAt',oldrow->'optedOutAt');
  focus_changed := ROW(newrow->'customerPropertyFocus',newrow->'customerPropertyFocusRevision') IS DISTINCT FROM ROW(oldrow->'customerPropertyFocus',oldrow->'customerPropertyFocusRevision');
  IF binding_changed OR owner_changed OR focus_changed THEN
    EXECUTE format('UPDATE "CustomerInquiry" SET "bindingRevision"="bindingRevision"+$1, "ownershipEpoch"="ownershipEpoch"+$2, "stateRevision"="stateRevision"+1,"updatedAt"=now() WHERE %I=$3',anchor)
      USING binding_changed::int,owner_changed::int,OLD."id";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_native_revisions AFTER UPDATE ON "BotConversation" FOR EACH ROW EXECUTE FUNCTION customer_native_revisions();
CREATE TRIGGER customer_native_revisions AFTER UPDATE ON "TelegramConversation" FOR EACH ROW EXECUTE FUNCTION customer_native_revisions();
CREATE TRIGGER customer_native_revisions AFTER UPDATE ON "TelegramDirectConversation" FOR EACH ROW EXECUTE FUNCTION customer_native_revisions();

-- Account deletion invokes two FK actions (native and scope SET NULL). Their
-- implicit order must not reverse native→scope used by the runtime. NO KEY
-- UPDATE is sufficient and compatible with creation-time FK KEY SHARE.
CREATE FUNCTION customer_account_lock_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id" THEN RAISE EXCEPTION 'customer account primary key is immutable'; END IF;
    IF ROW(NEW."enabled",NEW."channel",NEW."externalId",NEW."messagingId",NEW."extraExternalIds",NEW."appSecret",NEW."token") IS NOT DISTINCT FROM
       ROW(OLD."enabled",OLD."channel",OLD."externalId",OLD."messagingId",OLD."extraExternalIds",OLD."appSecret",OLD."token") THEN RETURN NEW; END IF;
  END IF;
  PERFORM "id" FROM "BotConversation" WHERE "accountId"=OLD."id" ORDER BY "id" FOR NO KEY UPDATE;
  PERFORM "id" FROM "CustomerEndpointScope" WHERE "messengerAccountId"=OLD."id" ORDER BY "id" FOR NO KEY UPDATE;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_account_lock_order BEFORE UPDATE OR DELETE ON "MessengerAccount"
  FOR EACH ROW EXECUTE FUNCTION customer_account_lock_order();

CREATE FUNCTION customer_account_revisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."enabled",NEW."channel",NEW."externalId",NEW."messagingId",NEW."extraExternalIds",NEW."appSecret",NEW."token") IS DISTINCT FROM
     ROW(OLD."enabled",OLD."channel",OLD."externalId",OLD."messagingId",OLD."extraExternalIds",OLD."appSecret",OLD."token") THEN
    UPDATE "CustomerEndpointScope" SET "scopeRevision"="scopeRevision"+1,"updatedAt"=now() WHERE "messengerAccountId"=NEW."id";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_account_revisions AFTER UPDATE ON "MessengerAccount" FOR EACH ROW EXECUTE FUNCTION customer_account_revisions();

CREATE FUNCTION customer_action_committed_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status"='COMMITTED' AND
    ROW(NEW."status",NEW."inquiryId",NEW."kind",NEW."generation",NEW."stateRevision",NEW."intentRevision",NEW."ownershipEpoch",NEW."bindingRevision",NEW."scopeRevision",NEW."policyRevision",NEW."evidenceRefs",NEW."resourceType",NEW."resourceId",NEW."receiptVersion",NEW."committedAt") IS DISTINCT FROM
    ROW(OLD."status",OLD."inquiryId",OLD."kind",OLD."generation",OLD."stateRevision",OLD."intentRevision",OLD."ownershipEpoch",OLD."bindingRevision",OLD."scopeRevision",OLD."policyRevision",OLD."evidenceRefs",OLD."resourceType",OLD."resourceId",OLD."receiptVersion",OLD."committedAt") THEN
    RAISE EXCEPTION 'committed customer resource receipt is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_action_committed_immutable BEFORE UPDATE ON "CustomerAction" FOR EACH ROW EXECUTE FUNCTION customer_action_committed_immutable();

-- Mixed-version legacy creation can supply only its old account fields. Attach
-- exact known installed routing, never infer a default Meta account or heal A→B.
CREATE FUNCTION customer_native_scope_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native jsonb := to_jsonb(NEW); business_channel text; transport_key text; account_id text; scope_id text; scope_kind text;
BEGIN
  business_channel := CASE WHEN TG_TABLE_NAME='BotConversation' THEN native->>'channel' ELSE 'TELEGRAM' END;
  IF NEW."endpointScopeId" IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD."endpointScopeId" IS NOT NULL THEN RETURN NEW; END IF;
  scope_kind := 'LEGACY_UNKNOWN'; account_id := NULL;
  IF TG_TABLE_NAME='BotConversation' THEN
    IF business_channel='WEBSITE' AND native->>'accountId' IS NULL THEN
      transport_key := 'website-public-chat'; scope_kind := 'NORMAL';
    ELSIF business_channel IN ('INSTAGRAM','FACEBOOK','WHATSAPP') AND EXISTS (
      SELECT 1 FROM "MessengerAccount" WHERE "id"=native->>'accountId' AND "channel"=business_channel
    ) THEN
      account_id := native->>'accountId'; transport_key := 'messenger-account:'||account_id; scope_kind := 'NORMAL';
    ELSIF native->>'accountId' IS NULL AND customer_db_installed_transport(business_channel) IS NOT NULL THEN
      transport_key := customer_db_installed_transport(business_channel); scope_kind := 'NORMAL';
    ELSE transport_key := 'legacy-bot:'||business_channel;
    END IF;
  ELSE transport_key := CASE WHEN TG_TABLE_NAME='TelegramConversation' THEN 'legacy-telegram-bot' ELSE 'legacy-telegram-direct' END;
  END IF;
  INSERT INTO "CustomerEndpointScope" ("id","realmKey","channel","transportKey","kind","messengerAccountId","updatedAt")
    VALUES (gen_random_uuid()::text,'royal-home',business_channel,transport_key,scope_kind,account_id,now())
    ON CONFLICT ("realmKey","channel","transportKey") DO NOTHING;
  SELECT "id" INTO scope_id FROM "CustomerEndpointScope" WHERE "realmKey"='royal-home' AND "channel"=business_channel AND "transportKey"=transport_key;
  NEW."endpointScopeId" := scope_id;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_native_scope_insert BEFORE INSERT OR UPDATE ON "BotConversation" FOR EACH ROW EXECUTE FUNCTION customer_native_scope_insert();
CREATE TRIGGER customer_native_scope_insert BEFORE INSERT OR UPDATE ON "TelegramConversation" FOR EACH ROW EXECUTE FUNCTION customer_native_scope_insert();
CREATE TRIGGER customer_native_scope_insert BEFORE INSERT OR UPDATE ON "TelegramDirectConversation" FOR EACH ROW EXECUTE FUNCTION customer_native_scope_insert();

CREATE FUNCTION customer_native_inquiry_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE native jsonb := to_jsonb(NEW); peer text; thread text := ''; anchor text;
BEGIN
  IF TG_TABLE_NAME='BotConversation' THEN peer:=native->>'subscriberId'; anchor:='conversationId';
  ELSIF TG_TABLE_NAME='TelegramConversation' THEN peer:=native->>'chatId'; anchor:='telegramConversationId';
  ELSE peer:=native->>'chatId'; thread:=native->>'topicId'; anchor:='telegramDirectConversationId'; END IF;
  -- Malformed historical raw keys remain unavailable, not a failing production expansion.
  IF NEW."endpointScopeId" IS NULL OR peer IS NULL OR length(peer) NOT BETWEEN 1 AND 512 OR length(thread)>512 THEN RETURN NEW; END IF;
  EXECUTE format('INSERT INTO "CustomerInquiry" ("id","endpointScopeId","peerId","threadId",%I,"updatedAt") VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT ("endpointScopeId","peerId","threadId") DO NOTHING',anchor)
    USING gen_random_uuid()::text,NEW."endpointScopeId",peer,thread,NEW."id";
  RETURN NEW;
END $$;
CREATE TRIGGER customer_native_inquiry_insert AFTER INSERT ON "BotConversation" FOR EACH ROW EXECUTE FUNCTION customer_native_inquiry_insert();
CREATE TRIGGER customer_native_inquiry_insert AFTER INSERT ON "TelegramConversation" FOR EACH ROW EXECUTE FUNCTION customer_native_inquiry_insert();
CREATE TRIGGER customer_native_inquiry_insert AFTER INSERT ON "TelegramDirectConversation" FOR EACH ROW EXECUTE FUNCTION customer_native_inquiry_insert();

-- A native FK need not change for a soft-delete/restore or profile merge ABA.
-- Invalidate captured plans without importing any private facts into state.
CREATE FUNCTION customer_client_binding_revisions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ownership_changed boolean := NEW."assignedAgentId" IS DISTINCT FROM OLD."assignedAgentId";
BEGIN
  IF NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt" OR ownership_changed THEN
    UPDATE "CustomerInquiry" i SET "bindingRevision"=i."bindingRevision"+1,
      "ownershipEpoch"=i."ownershipEpoch"+ownership_changed::int,"stateRevision"=i."stateRevision"+1,"updatedAt"=now()
    WHERE EXISTS (SELECT 1 FROM "BotConversation" c WHERE c."id"=i."conversationId" AND c."clientId"=NEW."id") OR
      EXISTS (SELECT 1 FROM "TelegramConversation" c WHERE c."id"=i."telegramConversationId" AND c."clientId"=NEW."id") OR
      EXISTS (SELECT 1 FROM "TelegramDirectConversation" c WHERE c."id"=i."telegramDirectConversationId" AND c."clientId"=NEW."id");
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_client_binding_revisions AFTER UPDATE ON "Client" FOR EACH ROW EXECUTE FUNCTION customer_client_binding_revisions();

CREATE FUNCTION customer_profile_binding_revisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."mergedIntoId" IS DISTINCT FROM OLD."mergedIntoId" THEN
    UPDATE "CustomerInquiry" i SET "bindingRevision"=i."bindingRevision"+1,"stateRevision"=i."stateRevision"+1,"updatedAt"=now()
    WHERE EXISTS (SELECT 1 FROM "BotConversation" c WHERE c."id"=i."conversationId" AND c."contactProfileId"=NEW."id") OR
      EXISTS (SELECT 1 FROM "TelegramConversation" c WHERE c."id"=i."telegramConversationId" AND c."contactProfileId"=NEW."id") OR
      EXISTS (SELECT 1 FROM "TelegramDirectConversation" c WHERE c."id"=i."telegramDirectConversationId" AND c."contactProfileId"=NEW."id");
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_profile_binding_revisions AFTER UPDATE ON "ContactProfile" FOR EACH ROW EXECUTE FUNCTION customer_profile_binding_revisions();

CREATE FUNCTION customer_settings_credentials_revisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Compare encrypted stored values only. Never decrypt/log credentials in SQL.
  IF ROW(NEW."metaAppSecret",NEW."metaIgAppSecret",NEW."metaWaToken",NEW."metaIgToken",NEW."metaPageToken",NEW."metaWaPhoneId",NEW."metaPageId") IS DISTINCT FROM
     ROW(OLD."metaAppSecret",OLD."metaIgAppSecret",OLD."metaWaToken",OLD."metaIgToken",OLD."metaPageToken",OLD."metaWaPhoneId",OLD."metaPageId") THEN
    PERFORM "id" FROM "CustomerEndpointScope" WHERE "channel" IN ('INSTAGRAM','FACEBOOK','WHATSAPP')
      ORDER BY "id" FOR NO KEY UPDATE;
    UPDATE "CustomerEndpointScope" SET "scopeRevision"="scopeRevision"+1,"updatedAt"=now()
      WHERE "channel" IN ('INSTAGRAM','FACEBOOK','WHATSAPP');
    UPDATE "CustomerRuntimePolicy" SET "policyRevision"="policyRevision"+1,"updatedAt"=now() WHERE "id"='singleton';
  END IF;
  IF ROW(NEW."botEnabled",NEW."botWhatsappEnabled",NEW."botInstagramEnabled",NEW."botFacebookEnabled",NEW."botTelegramEnabled",NEW."botWebsiteChatEnabled",NEW."metaEnabled") IS DISTINCT FROM
     ROW(OLD."botEnabled",OLD."botWhatsappEnabled",OLD."botInstagramEnabled",OLD."botFacebookEnabled",OLD."botTelegramEnabled",OLD."botWebsiteChatEnabled",OLD."metaEnabled") THEN
    UPDATE "CustomerRuntimePolicy" SET "policyRevision"="policyRevision"+1,"updatedAt"=now() WHERE "id"='singleton';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_settings_credentials_revisions AFTER UPDATE ON "Settings" FOR EACH ROW EXECUTE FUNCTION customer_settings_credentials_revisions();
