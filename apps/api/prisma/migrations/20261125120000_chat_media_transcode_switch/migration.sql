-- Копии голосовых/видео клиентов для любого браузера (25.11.2026), ВКЛ. Только новая колонка.
ALTER TABLE "Settings" ADD COLUMN "chatMediaTranscodeEnabled" BOOLEAN NOT NULL DEFAULT true;
