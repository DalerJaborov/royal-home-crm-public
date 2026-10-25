ALTER TABLE "Settings" ADD COLUMN "buyerSellerAutomationMode" TEXT NOT NULL DEFAULT 'PREVIEW';
-- Existing queued rows retain their earlier policy; new schedulers set this flag explicitly.
ALTER TABLE "PostShowingCall" ADD COLUMN "previewOnly" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SellerProbeCall" ADD COLUMN "previewOnly" BOOLEAN NOT NULL DEFAULT false;
-- Unknown historical assignment is never inferred from the current owner.
ALTER TABLE "InvestigationCase" ADD COLUMN "assignmentAt" TIMESTAMP(3);
