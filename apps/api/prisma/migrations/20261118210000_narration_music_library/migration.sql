-- Своя музыка для перемонтажа (18.11.2026, lib/narrationMusic.ts): библиотека треков и трек последнего перемонтажа объекта.
CREATE TABLE "NarrationMusicTrack" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "durationSec" DOUBLE PRECISION NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NarrationMusicTrack_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NarrationMusicTrack_storageKey_key" ON "NarrationMusicTrack"("storageKey");

ALTER TABLE "Property" ADD COLUMN "narrationMusicTrackId" TEXT;
