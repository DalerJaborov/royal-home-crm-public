-- Короткий сжатый ролик карточки объекта (docs/plan-18-08-private-listings-and-video.md §3).
-- Отдельно от PropertyVideo (исходники для монтажёра, R2) и instagramUrl (готовый Reels).

CREATE TYPE "PropertyClipVideoStatus" AS ENUM ('NONE', 'PROCESSING', 'READY', 'FAILED');

ALTER TABLE "Property"
  ADD COLUMN "clipVideoUrl" TEXT,
  ADD COLUMN "clipVideoStatus" "PropertyClipVideoStatus" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "clipVideoDurationSec" INTEGER,
  ADD COLUMN "clipVideoSizeBytes" INTEGER,
  ADD COLUMN "clipVideoUpdatedAt" TIMESTAMP(3);
