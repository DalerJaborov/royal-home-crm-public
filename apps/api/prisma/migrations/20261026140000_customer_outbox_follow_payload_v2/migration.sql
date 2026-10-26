-- The prior outbox shape constraint admitted only payloadVersion=1. The
-- buyer-guide follow instruction is the sole v2 payload and remains bound to
-- its dedicated purpose by both this shape check and the prior purpose check.
ALTER TABLE "CustomerOutboxPart"
  DROP CONSTRAINT "CustomerOutboxPart_shape_check";

ALTER TABLE "CustomerOutboxPart"
  ADD CONSTRAINT "CustomerOutboxPart_shape_check" CHECK (
    "ordinal">=0 AND "claimRevision">=0 AND
    ("payloadVersion"=1 OR ("payloadVersion"=2 AND "approvedAssetPurpose" IS NOT NULL AND "approvedAssetPurpose"='buyer_guide_follow')) AND
    "payloadHash" ~ '^[a-f0-9]{64}$' AND
    ("conversationId" IS NULL OR "conversationId"="originalNativeId") AND
    jsonb_typeof("transportJson")='object' AND jsonb_typeof("fenceJson")='object' AND
    jsonb_typeof("receiptRefsJson")='array'
  );

-- CHECK expressions accept SQL NULL. Explicitly close the nullable conversation
-- edge for any approved purpose without changing historical NULL-purpose rows.
ALTER TABLE "CustomerOutboxPart"
  ADD CONSTRAINT "customer_outbox_approved_asset_conversation_check" CHECK (
    "approvedAssetPurpose" IS NULL OR "conversationId" IS NOT NULL
  );

-- The purpose-specific indexes keep each operation idempotent. A current,
-- confirmed first-file request may coexist with an older UNKNOWN follow
-- instruction; the crossflow index incorrectly conflated those purposes.
DROP INDEX "customer_outbox_buyer_guide_flow_active_idx";
