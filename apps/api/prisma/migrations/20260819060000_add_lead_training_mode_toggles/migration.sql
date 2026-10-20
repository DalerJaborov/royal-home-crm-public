ALTER TABLE "Settings" ADD COLUMN "leadEscalationEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "leadReassignOnMissedCallEnabled" BOOLEAN NOT NULL DEFAULT false;
