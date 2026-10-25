-- AlterTable
ALTER TABLE "BuyerShowingCandidate" ADD COLUMN     "sourceExcerpt" TEXT,
ADD COLUMN     "sourceOccurredAt" TIMESTAMP(3),
ALTER COLUMN "proposedAt" DROP NOT NULL;

-- CreateTable
CREATE TABLE "SellerIntakeAppointmentEvidence" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "sourceInteractionId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "agentId" TEXT,
    "assignmentAt" TIMESTAMP(3) NOT NULL,
    "proposedAt" TIMESTAMP(3) NOT NULL,
    "sourceOccurredAt" TIMESTAMP(3) NOT NULL,
    "sourceExcerpt" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerIntakeAppointmentEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SellerIntakeAppointmentEvidence_sourceKey_key" ON "SellerIntakeAppointmentEvidence"("sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "SellerIntakeAppointmentEvidence_sourceInteractionId_key" ON "SellerIntakeAppointmentEvidence"("sourceInteractionId");

-- CreateIndex
CREATE INDEX "SellerIntakeAppointmentEvidence_clientId_assignmentAt_sourc_idx" ON "SellerIntakeAppointmentEvidence"("clientId", "assignmentAt", "sourceOccurredAt");

-- Authoritative collection start, never an inferred historical source timestamp.
INSERT INTO "WorkflowCheckpoint" ("key", "revision", "createdAt", "updatedAt") VALUES
  ('buyer-showing-candidates-v1', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('seller-intake-appointments-v1', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('owner-exposure-verification-v1', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- Old evidence version0 is preserved. Future evidence cannot invent a showing.
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_future_showing_evidence_check" CHECK (
  "showingEvidenceVersion" >= 0 AND (
    "showingEvidenceVersion" = 0 OR "type" <> 'SHOWING' OR (
      "nextActionDate" IS NOT NULL AND (
        ("propertyId" IS NOT NULL AND NOT "showingOffCrm") OR
        ("propertyId" IS NULL AND "showingOffCrm" AND char_length(trim(COALESCE("showingOffCrmDetails", ''))) >= 10)
      )
    )
  )
);

