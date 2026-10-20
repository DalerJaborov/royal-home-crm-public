-- Свободные ролики: выбор аккаунта публикации (12.10.2026) и сведения об ИИ-обложке. Аддитивно.
ALTER TABLE "SocialVideoPost" ADD COLUMN "coverMeta" JSONB;
ALTER TABLE "SocialVideoPost" ADD COLUMN "destinations" JSONB;
