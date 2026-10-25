ALTER TABLE "LiveVoiceSession" ADD COLUMN "investigationOnly" BOOLEAN NOT NULL DEFAULT false;

-- Exact provenance for linked historical sessions; do not classify ordinary calls by text.
UPDATE "LiveVoiceSession" s SET "investigationOnly" = true
WHERE EXISTS (SELECT 1 FROM "PostShowingCall" c WHERE c."channelId" = s."channelId")
   OR EXISTS (SELECT 1 FROM "SellerProbeCall" c WHERE c."channelId" = s."channelId")
   OR EXISTS (SELECT 1 FROM "ShowingSurveyCall" c WHERE c."channelId" = s."channelId");
