-- Additive only (12.11.2026). The editor mixes the approved narration himself and also hands in
-- the same clip without voice; "no narration" per property; approval reminders; staff clip intake.
ALTER TABLE "Property" ADD COLUMN "videoMasterRequestedAt" TIMESTAMP(3);
ALTER TABLE "Property" ADD COLUMN "narrationOff" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Property" ADD COLUMN "narrationOffAt" TIMESTAMP(3);

ALTER TABLE "PropertyNarrationVersion" ADD COLUMN "approvalRemindedAt" TIMESTAMP(3);
ALTER TABLE "PropertyNarrationVersion" ADD COLUMN "approvalEscalatedAt" TIMESTAMP(3);
ALTER TABLE "PropertyNarrationVersion" ADD COLUMN "editorDelayNotifiedAt" TIMESTAMP(3);

CREATE TABLE "StaffClipIntake" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "fileUniqueId" TEXT,
    "filename" TEXT NOT NULL,
    "caption" TEXT,
    "sizeBytes" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ASKING',
    "propertyId" TEXT,
    "candidates" JSONB,
    "excluded" JSONB,
    "decidedAt" TIMESTAMP(3),
    "result" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StaffClipIntake_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "StaffClipIntake_chatId_status_createdAt_idx" ON "StaffClipIntake"("chatId", "status", "createdAt");
CREATE INDEX "StaffClipIntake_fileUniqueId_idx" ON "StaffClipIntake"("fileUniqueId");
