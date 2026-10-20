-- Additive source proofs and public targets. No activation, backfill or provider calls.
ALTER TABLE "CustomerEndpointScope" ADD COLUMN "publicCredentialFingerprint" TEXT, ADD COLUMN "publicResourceId" TEXT;
ALTER TABLE "CustomerEndpointScope" ADD CONSTRAINT "customer_public_scope_shape" CHECK (
  ("publicCredentialFingerprint" IS NULL AND "publicResourceId" IS NULL AND "kind"<>'PUBLIC') OR
  ("publicCredentialFingerprint" IS NOT NULL AND "publicCredentialFingerprint" ~ '^[a-f0-9]{64}$'
   AND "publicResourceId" IS NOT NULL AND length("publicResourceId") BETWEEN 1 AND 512
   AND "realmKey"='customer-public' AND "kind" IN ('PUBLIC','LEGACY_UNKNOWN')
   AND "channel" IN ('INSTAGRAM','FACEBOOK','TELEGRAM','YOUTUBE'))
);
CREATE OR REPLACE FUNCTION customer_scope_revisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."scopeRevision" < OLD."scopeRevision" THEN RAISE EXCEPTION 'customer scope revision cannot decrease'; END IF;
  IF OLD."messengerAccountId" IS NOT NULL AND NEW."messengerAccountId" IS NULL THEN NEW."kind" := 'LEGACY_UNKNOWN'; END IF;
  IF ROW(NEW."realmKey",NEW."channel",NEW."transportKey",NEW."kind",NEW."messengerAccountId",NEW."publicCredentialFingerprint",NEW."publicResourceId") IS DISTINCT FROM
     ROW(OLD."realmKey",OLD."channel",OLD."transportKey",OLD."kind",OLD."messengerAccountId",OLD."publicCredentialFingerprint",OLD."publicResourceId") THEN
    NEW."scopeRevision" := GREATEST(NEW."scopeRevision",OLD."scopeRevision"+1); NEW."updatedAt" := now();
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE "CustomerPropertyIngressTicket" ADD COLUMN "senderObservationVersion" INTEGER,
  ADD COLUMN "senderObservationCiphertext" TEXT, ADD COLUMN "senderObservedAt" TIMESTAMP(3);
ALTER TABLE "CustomerPropertyIngressTicket" ADD CONSTRAINT "customer_sender_observation_shape" CHECK (
  ("senderObservationVersion" IS NULL AND "senderObservationCiphertext" IS NULL AND "senderObservedAt" IS NULL) OR
  ("senderObservationVersion" IS NOT NULL AND "senderObservationVersion"=1 AND "senderObservationCiphertext" IS NOT NULL
   AND length("senderObservationCiphertext")>0 AND "senderObservedAt" IS NOT NULL
   AND "receivedAt" IS NOT NULL AND "payloadVersion" IS NOT NULL AND "payloadVersion"=1
   AND "senderObservedAt">="receivedAt" AND "senderObservedAt"<="receivedAt"+interval '15 minutes')
);
CREATE FUNCTION customer_sender_observation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."senderObservationVersion" IS NOT NULL AND
    ROW(NEW."senderObservationVersion",NEW."senderObservationCiphertext",NEW."senderObservedAt") IS DISTINCT FROM
    ROW(OLD."senderObservationVersion",OLD."senderObservationCiphertext",OLD."senderObservedAt") THEN
    RAISE EXCEPTION 'customer sender observation cannot be replaced';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_sender_observation_immutable BEFORE UPDATE ON "CustomerPropertyIngressTicket"
  FOR EACH ROW EXECUTE FUNCTION customer_sender_observation_immutable();

ALTER TABLE "InstagramComment" ADD COLUMN "publicSourceRevision" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "publicOriginVersion" INTEGER, ADD COLUMN "publicOriginCiphertext" TEXT, ADD COLUMN "publicOriginCapturedAt" TIMESTAMP(3);
ALTER TABLE "TelegramGroupComment" ADD COLUMN "publicSourceRevision" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "publicOriginVersion" INTEGER, ADD COLUMN "publicOriginCiphertext" TEXT, ADD COLUMN "publicOriginCapturedAt" TIMESTAMP(3);
ALTER TABLE "InstagramComment" ADD CONSTRAINT "customer_meta_origin_shape" CHECK (
  "publicSourceRevision">=0 AND (("publicOriginVersion" IS NULL AND "publicOriginCiphertext" IS NULL AND "publicOriginCapturedAt" IS NULL) OR
   ("publicOriginVersion" IS NOT NULL AND "publicOriginVersion"=1 AND "publicOriginCiphertext" IS NOT NULL AND length("publicOriginCiphertext")>0 AND "publicOriginCapturedAt" IS NOT NULL))
);
ALTER TABLE "TelegramGroupComment" ADD CONSTRAINT "customer_tg_origin_shape" CHECK (
  "publicSourceRevision">=0 AND (("publicOriginVersion" IS NULL AND "publicOriginCiphertext" IS NULL AND "publicOriginCapturedAt" IS NULL) OR
   ("publicOriginVersion" IS NOT NULL AND "publicOriginVersion"=1 AND "publicOriginCiphertext" IS NOT NULL AND length("publicOriginCiphertext")>0 AND "publicOriginCapturedAt" IS NOT NULL))
);
CREATE FUNCTION customer_public_source_revisions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed boolean;
BEGIN
  IF NEW."publicSourceRevision"<OLD."publicSourceRevision" THEN RAISE EXCEPTION 'public source revision cannot decrease'; END IF;
  IF OLD."publicOriginVersion" IS NOT NULL AND
    ROW(NEW."publicOriginVersion",NEW."publicOriginCiphertext",NEW."publicOriginCapturedAt") IS DISTINCT FROM
    ROW(OLD."publicOriginVersion",OLD."publicOriginCiphertext",OLD."publicOriginCapturedAt") THEN
    RAISE EXCEPTION 'original public source proof cannot be renewed';
  END IF;
  changed := ROW(NEW."text",NEW."authorId") IS DISTINCT FROM ROW(OLD."text",OLD."authorId")
    OR (NEW."status" IS DISTINCT FROM OLD."status" AND
      NOT (NEW."status" IN ('PENDING','WORKING','ERROR') AND OLD."status" IN ('PENDING','WORKING','ERROR')));
  IF TG_TABLE_NAME='InstagramComment' THEN
    changed := changed OR ROW(NEW."channel",NEW."commentId",NEW."mediaId",NEW."accountExternalId",NEW."parentId",NEW."replyText",NEW."replyCommentId",NEW."repliedAt",NEW."hiddenAt",NEW."statusBeforeHide") IS DISTINCT FROM
      ROW(OLD."channel",OLD."commentId",OLD."mediaId",OLD."accountExternalId",OLD."parentId",OLD."replyText",OLD."replyCommentId",OLD."repliedAt",OLD."hiddenAt",OLD."statusBeforeHide");
  ELSE
    changed := changed OR ROW(NEW."messageId",NEW."groupChatId",NEW."postMessageId",NEW."replyText",NEW."replyMessageId",NEW."repliedAt") IS DISTINCT FROM
      ROW(OLD."messageId",OLD."groupChatId",OLD."postMessageId",OLD."replyText",OLD."replyMessageId",OLD."repliedAt");
  END IF;
  IF changed THEN NEW."publicSourceRevision" := GREATEST(NEW."publicSourceRevision",OLD."publicSourceRevision"+1); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_public_source_revisions BEFORE UPDATE ON "InstagramComment"
  FOR EACH ROW EXECUTE FUNCTION customer_public_source_revisions();
CREATE TRIGGER customer_public_source_revisions BEFORE UPDATE ON "TelegramGroupComment"
  FOR EACH ROW EXECUTE FUNCTION customer_public_source_revisions();

ALTER TABLE "CustomerOutboxPart" ALTER COLUMN "inquiryId" DROP NOT NULL,
  ADD COLUMN "publicMetaCommentId" TEXT, ADD COLUMN "publicTelegramCommentId" TEXT, ADD COLUMN "publicSourceRevision" BIGINT;
ALTER TABLE "CustomerOutboxPart" DROP CONSTRAINT "CustomerOutboxPart_source_check";
ALTER TABLE "CustomerOutboxPart" ADD CONSTRAINT "CustomerOutboxPart_source_check" CHECK ("sourceKind" IN ('BOT_TURN','STAFF_ANSWER','PUBLIC_COMMENT_REPLY'));
ALTER TABLE "CustomerOutboxPart" ADD CONSTRAINT "customer_outbox_source_shape" CHECK (
  ("sourceKind" IN ('BOT_TURN','STAFF_ANSWER') AND "inquiryId" IS NOT NULL AND "publicMetaCommentId" IS NULL
    AND "publicTelegramCommentId" IS NULL AND "publicSourceRevision" IS NULL) OR
  ("sourceKind"='PUBLIC_COMMENT_REPLY' AND "inquiryId" IS NULL AND "conversationId" IS NULL AND "ticketEventKey" IS NULL
    AND "publicSourceRevision" IS NOT NULL AND "publicSourceRevision">=0
    AND (("publicMetaCommentId" IS NOT NULL AND "publicMetaCommentId"="originalNativeId" AND "publicTelegramCommentId" IS NULL AND "channel" IN ('INSTAGRAM','FACEBOOK','YOUTUBE'))
      OR ("publicTelegramCommentId" IS NOT NULL AND "publicTelegramCommentId"="originalNativeId" AND "publicMetaCommentId" IS NULL AND "channel"='TELEGRAM')
      OR ("publicMetaCommentId" IS NULL AND "publicTelegramCommentId" IS NULL AND "cancelRequestedAt" IS NOT NULL)))
);
ALTER TABLE "CustomerOutboxPart" ADD CONSTRAINT "CustomerOutboxPart_publicMetaCommentId_fkey" FOREIGN KEY ("publicMetaCommentId") REFERENCES "InstagramComment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CustomerOutboxPart" ADD CONSTRAINT "CustomerOutboxPart_publicTelegramCommentId_fkey" FOREIGN KEY ("publicTelegramCommentId") REFERENCES "TelegramGroupComment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "customer_outbox_public_meta_source_idx" ON "CustomerOutboxPart"("publicMetaCommentId","publicSourceRevision");
CREATE INDEX "customer_outbox_public_tg_source_idx" ON "CustomerOutboxPart"("publicTelegramCommentId","publicSourceRevision");
CREATE FUNCTION customer_public_part_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW."sourceKind"='PUBLIC_COMMENT_REPLY' AND NEW."publicMetaCommentId" IS NULL AND NEW."publicTelegramCommentId" IS NULL THEN
      RAISE EXCEPTION 'public part must reference its original source';
    END IF;
  ELSE
    IF NEW."publicSourceRevision" IS DISTINCT FROM OLD."publicSourceRevision" OR
      (NEW."publicMetaCommentId" IS DISTINCT FROM OLD."publicMetaCommentId" AND NEW."publicMetaCommentId" IS NOT NULL) OR
      (NEW."publicTelegramCommentId" IS DISTINCT FROM OLD."publicTelegramCommentId" AND NEW."publicTelegramCommentId" IS NOT NULL) THEN
      RAISE EXCEPTION 'public part source cannot change';
    END IF;
    IF (OLD."publicMetaCommentId" IS NOT NULL AND NEW."publicMetaCommentId" IS NULL) OR
       (OLD."publicTelegramCommentId" IS NOT NULL AND NEW."publicTelegramCommentId" IS NULL) THEN
      NEW."cancelRequestedAt" := coalesce(OLD."cancelRequestedAt",now());
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_public_part_identity BEFORE INSERT OR UPDATE ON "CustomerOutboxPart"
  FOR EACH ROW EXECUTE FUNCTION customer_public_part_identity();

-- Public origins carry encrypted revision pins without an additional FK.
CREATE FUNCTION customer_agent_revision_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable customer agent revision cannot be deleted'; END $$;
CREATE TRIGGER customer_agent_revision_no_delete BEFORE DELETE ON "CustomerAgentRevision"
  FOR EACH ROW EXECUTE FUNCTION customer_agent_revision_no_delete();

-- Lock all affected scopes before ANY policy lock, including combined edits.
CREATE OR REPLACE FUNCTION customer_settings_credentials_revisions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE meta_changed boolean; enabled_changed boolean; public_changed boolean;
BEGIN
  meta_changed := ROW(NEW."metaAppSecret",NEW."metaIgAppSecret",NEW."metaWaToken",NEW."metaIgToken",NEW."metaPageToken",NEW."metaWaPhoneId",NEW."metaPageId") IS DISTINCT FROM
    ROW(OLD."metaAppSecret",OLD."metaIgAppSecret",OLD."metaWaToken",OLD."metaIgToken",OLD."metaPageToken",OLD."metaWaPhoneId",OLD."metaPageId");
  enabled_changed := ROW(NEW."botEnabled",NEW."botWhatsappEnabled",NEW."botInstagramEnabled",NEW."botFacebookEnabled",NEW."botTelegramEnabled",NEW."botWebsiteChatEnabled",NEW."metaEnabled") IS DISTINCT FROM
    ROW(OLD."botEnabled",OLD."botWhatsappEnabled",OLD."botInstagramEnabled",OLD."botFacebookEnabled",OLD."botTelegramEnabled",OLD."botWebsiteChatEnabled",OLD."metaEnabled");
  public_changed := ROW(NEW."botCanAnswerComments",NEW."botCommentPrompt",NEW."telegramDiscussionGroupId",NEW."telegramChannelId",NEW."youtubeClientId",NEW."youtubeClientSecret",NEW."youtubeRefreshToken") IS DISTINCT FROM
    ROW(OLD."botCanAnswerComments",OLD."botCommentPrompt",OLD."telegramDiscussionGroupId",OLD."telegramChannelId",OLD."youtubeClientId",OLD."youtubeClientSecret",OLD."youtubeRefreshToken");
  IF meta_changed OR public_changed THEN
    PERFORM "id" FROM "CustomerEndpointScope" WHERE (meta_changed AND "channel" IN ('INSTAGRAM','FACEBOOK','WHATSAPP')) OR
      (public_changed AND "realmKey"='customer-public') ORDER BY "id" FOR NO KEY UPDATE;
    UPDATE "CustomerEndpointScope" SET "scopeRevision"="scopeRevision"+1,"updatedAt"=now()
      WHERE (meta_changed AND "channel" IN ('INSTAGRAM','FACEBOOK','WHATSAPP')) OR (public_changed AND "realmKey"='customer-public');
  END IF;
  IF meta_changed THEN UPDATE "CustomerRuntimePolicy" SET "policyRevision"="policyRevision"+1,"updatedAt"=now() WHERE "id"='singleton'; END IF;
  IF enabled_changed THEN UPDATE "CustomerRuntimePolicy" SET "policyRevision"="policyRevision"+1,"updatedAt"=now() WHERE "id"='singleton'; END IF;
  IF public_changed THEN UPDATE "CustomerRuntimePolicy" SET "policyRevision"="policyRevision"+1,"updatedAt"=now() WHERE "id"='singleton'; END IF;
  RETURN NEW;
END $$;
