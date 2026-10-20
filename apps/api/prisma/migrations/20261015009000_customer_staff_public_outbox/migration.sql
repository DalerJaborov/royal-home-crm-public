-- Staff public replies share the existing journal; they never acquire BOT/model authority.
ALTER TABLE "CustomerOutboxPart" DROP CONSTRAINT "CustomerOutboxPart_source_check";
ALTER TABLE "CustomerOutboxPart" ADD CONSTRAINT "CustomerOutboxPart_source_check" CHECK
  ("sourceKind" IN ('BOT_TURN','STAFF_ANSWER','PUBLIC_COMMENT_REPLY','STAFF_PUBLIC_COMMENT_REPLY'));
ALTER TABLE "CustomerOutboxPart" DROP CONSTRAINT "customer_outbox_source_shape";
ALTER TABLE "CustomerOutboxPart" ADD CONSTRAINT "customer_outbox_source_shape" CHECK (
  ("sourceKind" IN ('BOT_TURN','STAFF_ANSWER') AND "inquiryId" IS NOT NULL AND "publicMetaCommentId" IS NULL
    AND "publicTelegramCommentId" IS NULL AND "publicSourceRevision" IS NULL) OR
  ("sourceKind" IN ('PUBLIC_COMMENT_REPLY','STAFF_PUBLIC_COMMENT_REPLY') AND "inquiryId" IS NULL AND "conversationId" IS NULL AND "ticketEventKey" IS NULL
    AND "publicSourceRevision" IS NOT NULL AND "publicSourceRevision">=0
    AND (("publicMetaCommentId" IS NOT NULL AND "publicMetaCommentId"="originalNativeId" AND "publicTelegramCommentId" IS NULL AND "channel" IN ('INSTAGRAM','FACEBOOK','YOUTUBE'))
      OR ("publicTelegramCommentId" IS NOT NULL AND "publicTelegramCommentId"="originalNativeId" AND "publicMetaCommentId" IS NULL AND "channel"='TELEGRAM')
      OR ("publicMetaCommentId" IS NULL AND "publicTelegramCommentId" IS NULL AND "cancelRequestedAt" IS NOT NULL))
    AND ("sourceKind"<>'STAFF_PUBLIC_COMMENT_REPLY' OR ("agentRevisionId" IS NULL AND "p03Json" IS NULL AND "receiptRefsJson"='[]'::jsonb)))
);
CREATE OR REPLACE FUNCTION customer_public_part_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW."sourceKind" IN ('PUBLIC_COMMENT_REPLY','STAFF_PUBLIC_COMMENT_REPLY') AND
      NEW."publicMetaCommentId" IS NULL AND NEW."publicTelegramCommentId" IS NULL THEN
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
