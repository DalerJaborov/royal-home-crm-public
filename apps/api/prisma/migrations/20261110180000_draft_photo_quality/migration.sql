-- Мастер объекта: качество фото (10.11.2026). Только добавление столбцов с умолчанием.
ALTER TABLE "PropertyDraft" ADD COLUMN "compressedPhotoNoticeAt" TIMESTAMP(3);
ALTER TABLE "PropertyDraft" ADD COLUMN "compressedPhotoChoice" TEXT;
ALTER TABLE "PropertyDraftMedia" ADD COLUMN "qualityFlags" TEXT[] DEFAULT ARRAY[]::TEXT[];
