-- Обложки объектов через OpenAI Images (25.09.2026, решение владельца).
ALTER TABLE "Property" ADD COLUMN "socialCoverInputHash" TEXT;
ALTER TABLE "Property" ADD COLUMN "socialCoverError" TEXT;
ALTER TABLE "Settings" ADD COLUMN "openaiApiKey" TEXT;
ALTER TABLE "Settings" ADD COLUMN "coverGenerationEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "openaiImageQuality" TEXT NOT NULL DEFAULT 'high';
ALTER TABLE "Settings" ADD COLUMN "openaiCoverDailyLimit" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "Settings" ADD COLUMN "openaiSquareSeparate" BOOLEAN NOT NULL DEFAULT false;
