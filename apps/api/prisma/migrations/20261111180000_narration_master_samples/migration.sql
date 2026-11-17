-- Additive only (11.11.2026). Voice-less master clip from the editor: CRM mixes the approved
-- narration itself, so a price change no longer needs the editor. Plus one-time voice samples.
ALTER TABLE "Property" ADD COLUMN "videoMasterStorageKey" TEXT;
ALTER TABLE "Property" ADD COLUMN "videoMasterNarrationVersionId" TEXT;
ALTER TABLE "Property" ADD COLUMN "videoMasterMixError" TEXT;
ALTER TABLE "Property" ADD COLUMN "videoMasterMixErrorVersionId" TEXT;

CREATE TABLE "NarrationVoiceSample" (
    "id" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "chars" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'GENERATING',
    "storageKey" TEXT,
    "errorCode" TEXT,
    "generationStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NarrationVoiceSample_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NarrationVoiceSample_voiceId_modelId_textHash_key" ON "NarrationVoiceSample"("voiceId", "modelId", "textHash");
CREATE INDEX "NarrationVoiceSample_generationStartedAt_idx" ON "NarrationVoiceSample"("generationStartedAt");
