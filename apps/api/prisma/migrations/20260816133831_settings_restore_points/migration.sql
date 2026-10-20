-- CreateTable
CREATE TABLE "SettingsSnapshot" (
    "id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "agentId" TEXT,
    "agentName" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'update',
    "changedFields" TEXT[],
    "keyFingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettingsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SettingsSnapshot_createdAt_idx" ON "SettingsSnapshot"("createdAt");
