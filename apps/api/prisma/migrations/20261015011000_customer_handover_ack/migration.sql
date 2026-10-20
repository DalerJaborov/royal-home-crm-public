-- Add only the fixed ACK purpose for an existing committed handover.
-- No table/column, no task or attempt journal, no change to ordinary BOT OUT permission.
ALTER TABLE "CustomerOutboxPart" DROP CONSTRAINT "CustomerOutboxPart_source_check";
ALTER TABLE "CustomerOutboxPart" ADD CONSTRAINT "CustomerOutboxPart_source_check" CHECK
  ("sourceKind" IN ('BOT_TURN','STAFF_ANSWER','PUBLIC_COMMENT_REPLY','STAFF_PUBLIC_COMMENT_REPLY','HANDOVER_ACK'));

ALTER TABLE "CustomerOutboxPart" DROP CONSTRAINT "customer_outbox_source_shape";
ALTER TABLE "CustomerOutboxPart" ADD CONSTRAINT "customer_outbox_source_shape" CHECK (
  ("sourceKind" IN ('BOT_TURN','STAFF_ANSWER') AND "inquiryId" IS NOT NULL AND "publicMetaCommentId" IS NULL
    AND "publicTelegramCommentId" IS NULL AND "publicSourceRevision" IS NULL) OR
  ("sourceKind" IN ('PUBLIC_COMMENT_REPLY','STAFF_PUBLIC_COMMENT_REPLY') AND "inquiryId" IS NULL AND "conversationId" IS NULL AND "ticketEventKey" IS NULL
    AND "publicSourceRevision" IS NOT NULL AND "publicSourceRevision">=0
    AND (("publicMetaCommentId" IS NOT NULL AND "publicMetaCommentId"="originalNativeId" AND "publicTelegramCommentId" IS NULL AND "channel" IN ('INSTAGRAM','FACEBOOK','YOUTUBE'))
      OR ("publicTelegramCommentId" IS NOT NULL AND "publicTelegramCommentId"="originalNativeId" AND "publicMetaCommentId" IS NULL AND "channel"='TELEGRAM')
      OR ("publicMetaCommentId" IS NULL AND "publicTelegramCommentId" IS NULL AND "cancelRequestedAt" IS NOT NULL))
    AND ("sourceKind"<>'STAFF_PUBLIC_COMMENT_REPLY' OR ("agentRevisionId" IS NULL AND "p03Json" IS NULL AND "receiptRefsJson"='[]'::jsonb))) OR
  ("sourceKind"='HANDOVER_ACK' AND (
    "inquiryId" IS NOT NULL AND ("conversationId"="originalNativeId" OR ("conversationId" IS NULL AND "cancelRequestedAt" IS NOT NULL))
    AND "ticketEventKey" IS NOT NULL AND "turnKey"="ticketEventKey" AND "ordinal"=0 AND "mode"='LIVE'
    AND "channel" IN ('INSTAGRAM','FACEBOOK','WHATSAPP') AND "agentRevisionId" IS NOT NULL
    AND "publicMetaCommentId" IS NULL AND "publicTelegramCommentId" IS NULL AND "publicSourceRevision" IS NULL AND "p03Json" IS NULL
    AND jsonb_typeof("receiptRefsJson")='array' AND jsonb_array_length("receiptRefsJson")=1
    AND "receiptRefsJson"->0->>'version'='2' AND "receiptRefsJson"->0->>'kind'='handover'
    AND "receiptRefsJson"->0->>'outcome'='handover_requested' AND "receiptRefsJson"->0->>'resourceType'='CallbackRequest'
    AND "sourceKey"="receiptRefsJson"->0->>'actionId'
    AND "fenceJson"->>'version'='1' AND "fenceJson"->>'purpose'='handover_ack'
    AND "fenceJson"->>'eventKey'="ticketEventKey" AND "fenceJson"->'receipt'="receiptRefsJson"->0
    AND "fenceJson"->'after'->>'inquiryId'="inquiryId"
    AND "fenceJson"->'after'->>'nativeId'="originalNativeId"
    AND "fenceJson"->'after'->'endpoint'->>'endpointScopeId'="endpointScopeId"
    AND "fenceJson"->>'agentRevisionId'="agentRevisionId"
  ) IS TRUE)
);
CREATE UNIQUE INDEX "customer_handover_ack_action_once" ON "CustomerOutboxPart"("sourceKey") WHERE "sourceKind"='HANDOVER_ACK';
-- Existing identity trigger already freezes sourceKey/fenceJson/receiptRefsJson/payload/target.
-- Existing native SetNull/cancellation remains compatible; a tombstone cannot pass
-- runtime ACK validation or cause POST. Accepted Attempt receipt is retained.
