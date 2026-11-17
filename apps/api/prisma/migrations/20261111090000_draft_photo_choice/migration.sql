-- Мастер объекта: ответ на вопрос о сжатых фото (11.11.2026). Отдельной миграцией:
-- 20261110180000_draft_photo_quality уже могла быть применена на стендах и локальных базах.
ALTER TABLE "PropertyDraft" ADD COLUMN IF NOT EXISTS "compressedPhotoChoice" TEXT;
