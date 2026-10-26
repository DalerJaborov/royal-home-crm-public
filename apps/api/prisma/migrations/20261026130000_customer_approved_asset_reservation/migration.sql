ALTER TABLE "CustomerOutboxPart"
  ADD COLUMN "approvedAssetPurpose" TEXT;

ALTER TABLE "CustomerOutboxPart"
  ADD CONSTRAINT "customer_outbox_approved_asset_purpose_check" CHECK (
    "approvedAssetPurpose" IS NULL OR (
      "approvedAssetPurpose" IN ('buyer_guide','buyer_guide_follow') AND
      "sourceKind"='BOT_TURN' AND "mode"='LIVE' AND "ticketEventKey" IS NOT NULL AND
      "conversationId"="originalNativeId" AND "channel" IN ('INSTAGRAM','FACEBOOK','WHATSAPP') AND
      "agentRevisionId" IS NOT NULL AND
      (("approvedAssetPurpose"='buyer_guide' AND "ordinal">0 AND "payloadVersion"=1 AND
        "p03Json" IS NULL AND "receiptRefsJson"='[]'::jsonb) OR
       ("approvedAssetPurpose"='buyer_guide_follow' AND "ordinal"=0 AND "payloadVersion"=2 AND "channel"='INSTAGRAM'))
    )
  );

-- A pending/accepted/ambiguous buyer-guide part reserves the one-per-dialog
-- right. UNKNOWN is deliberately included: another turn cannot blindly resend.
CREATE UNIQUE INDEX "customer_outbox_buyer_guide_once_idx"
  ON "CustomerOutboxPart" ("originalNativeId")
  WHERE "approvedAssetPurpose"='buyer_guide' AND "status" IN ('READY','IN_FLIGHT','ACCEPTED','UNKNOWN');

-- Once the accepted prompt is projected in the same transaction, its seven-day
-- guideAwaitFollowAt marker takes over. Keep a reservation while projection is
-- pending so a later turn cannot duplicate an accepted-but-unprojected prompt.
CREATE UNIQUE INDEX "customer_outbox_buyer_guide_follow_pending_idx"
  ON "CustomerOutboxPart" ("originalNativeId")
  WHERE "approvedAssetPurpose"='buyer_guide_follow' AND
    ("status" IN ('READY','IN_FLIGHT','UNKNOWN') OR ("status"='ACCEPTED' AND "projectionRecordedAt" IS NULL));

-- A pending file and a pending follow prompt are one mutually exclusive guide
-- workflow, even though they have different purpose-specific recovery rules.
CREATE UNIQUE INDEX "customer_outbox_buyer_guide_flow_active_idx"
  ON "CustomerOutboxPart" ("originalNativeId")
  WHERE "approvedAssetPurpose" IS NOT NULL AND
    ("status" IN ('READY','IN_FLIGHT','UNKNOWN') OR "approvedAssetPurpose"='buyer_guide' AND "status"='ACCEPTED' OR
      "approvedAssetPurpose"='buyer_guide_follow' AND "status"='ACCEPTED' AND "projectionRecordedAt" IS NULL);

CREATE FUNCTION customer_outbox_approved_asset_purpose_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."approvedAssetPurpose" IS DISTINCT FROM OLD."approvedAssetPurpose" THEN
    RAISE EXCEPTION 'customer outbox approved asset purpose cannot change';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER customer_outbox_approved_asset_purpose_immutable BEFORE UPDATE ON "CustomerOutboxPart"
  FOR EACH ROW EXECUTE FUNCTION customer_outbox_approved_asset_purpose_immutable();
