-- Свободные ролики: отпечаток файла для проверки «этот файл уже загружали» (12.10.2026). Аддитивно.
ALTER TABLE "SocialVideoPost" ADD COLUMN "contentHash" TEXT;
CREATE INDEX "SocialVideoPost_contentHash_idx" ON "SocialVideoPost"("contentHash");
