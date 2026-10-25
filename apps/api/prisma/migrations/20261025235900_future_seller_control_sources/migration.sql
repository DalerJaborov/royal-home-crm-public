-- Freeze execution eligibility when a future immutable intake source is recorded.
-- Historical sources retain PREVIEW. Workflow binding does not rewrite source facts.
ALTER TABLE "SellerIntakeAppointmentEvidence" ADD COLUMN "executionMode" TEXT NOT NULL DEFAULT 'PREVIEW';
ALTER TABLE "SellerIntakeAppointmentEvidence" ADD COLUMN "controlEpisodeId" TEXT;
CREATE INDEX "SellerIntakeAppointmentEvidence_executionMode_controlEpisodeId_sourceOccurredAt_idx"
  ON "SellerIntakeAppointmentEvidence"("executionMode", "controlEpisodeId", "sourceOccurredAt");
ALTER TABLE "SellerControlEpisode" ADD COLUMN "sellerIntakeEvidenceId" TEXT;
CREATE UNIQUE INDEX "SellerControlEpisode_sellerIntakeEvidenceId_key" ON "SellerControlEpisode"("sellerIntakeEvidenceId");
