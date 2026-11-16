-- Новая озвучка на вышедший ролик без монтажёра (16.11.2026): машинный мастер и подгонка длины.
ALTER TABLE "Property" ADD COLUMN "videoMasterSource" TEXT;
ALTER TABLE "Property" ADD COLUMN "videoMasterAutoError" TEXT;
ALTER TABLE "Property" ADD COLUMN "videoMasterAutoErrorFinalPath" TEXT;
ALTER TABLE "PropertyNarrationVersion" ADD COLUMN "shortenedFromId" TEXT;
ALTER TABLE "PropertyNarrationVersion" ADD COLUMN "mixNote" TEXT;
