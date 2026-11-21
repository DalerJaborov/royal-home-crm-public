-- Additive only (19.11.2026, review of montajer queue controls): current-round remake reason and «skipped by montajer» mark.
ALTER TABLE "Property" ADD COLUMN "videoHandoffRoundRemakeReason" TEXT;
ALTER TABLE "Property" ADD COLUMN "videoHandoffRoundRemakeComment" TEXT;
ALTER TABLE "Property" ADD COLUMN "videoHandoffMontajerSkippedAt" TIMESTAMP(3);
