ALTER TABLE "Client"
 ADD COLUMN "dualIntentDecisionSource" TEXT,
 ADD COLUMN "dualIntentNeedsReview" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "dualIntentEvidence" JSONB,
 ADD COLUMN "dualIntentAnalyzedHash" TEXT;

-- Existing explicit human decisions remain authoritative.
UPDATE "Client" SET "dualIntentDecisionSource"='MANUAL'
WHERE "dualIntentConfirmedById" IS NOT NULL
 OR id IN (SELECT "entityId" FROM "AuditLog" WHERE "entityType"='Client'
   AND action='UPDATE' AND meta->>'confirmation'='staff');
