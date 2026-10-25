-- Historical cases intentionally retain NULL: an assignment identity cannot be reconstructed safely.
ALTER TABLE "InvestigationCase" ADD COLUMN "assignmentEpochKey" TEXT;
