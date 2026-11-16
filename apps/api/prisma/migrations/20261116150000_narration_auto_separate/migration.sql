-- Новая озвучка на вышедший ролик без монтажёра (16.11.2026): машинный мастер и подгонка длины.
ALTER TABLE "Property" ADD COLUMN "videoMasterSource" TEXT;
ALTER TABLE "Property" ADD COLUMN "videoMasterAutoError" TEXT;
ALTER TABLE "Property" ADD COLUMN "videoMasterAutoErrorFinalPath" TEXT;
ALTER TABLE "Property" ADD COLUMN "videoMasterAutoAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Property" ADD COLUMN "videoMasterAutoRetryAt" TIMESTAMP(3);
ALTER TABLE "PropertyNarrationVersion" ADD COLUMN "shortenedFromId" TEXT;
ALTER TABLE "PropertyNarrationVersion" ADD COLUMN "mixNote" TEXT;
