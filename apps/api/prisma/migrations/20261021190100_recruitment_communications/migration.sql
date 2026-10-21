CREATE TABLE "RecruitmentCommunication" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "previewId" TEXT NOT NULL,
  "jobApplicationId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PREVIEW',
  "previewHash" TEXT NOT NULL,
  "snapshotJson" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "idempotencyKey" TEXT,
  "effectKey" TEXT,
  "providerReceipt" TEXT,
  "providerStatus" TEXT,
  "reason" TEXT,
  "resultJson" JSONB,
  "attemptStartedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "RecruitmentCommunication_previewId_channel_key" ON "RecruitmentCommunication"("previewId", "channel");
CREATE UNIQUE INDEX "RecruitmentCommunication_actorId_idempotencyKey_channel_key" ON "RecruitmentCommunication"("actorId", "idempotencyKey", "channel");
CREATE UNIQUE INDEX "RecruitmentCommunication_effectKey_key" ON "RecruitmentCommunication"("effectKey");
CREATE INDEX "RecruitmentCommunication_jobApplicationId_createdAt_idx" ON "RecruitmentCommunication"("jobApplicationId", "createdAt");
CREATE INDEX "RecruitmentCommunication_status_createdAt_idx" ON "RecruitmentCommunication"("status", "createdAt");
CREATE INDEX "RecruitmentCommunication_providerReceipt_idx" ON "RecruitmentCommunication"("providerReceipt");
