-- Additive only (12.11.2026, review fixes): wizard-created marker, remix claim, staff clip switch.
ALTER TABLE "Property" ADD COLUMN "createdInCrmWizard" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Property" ADD COLUMN "videoMasterMixingAt" TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN "staffClipIntakeEnabled" BOOLEAN NOT NULL DEFAULT true;
