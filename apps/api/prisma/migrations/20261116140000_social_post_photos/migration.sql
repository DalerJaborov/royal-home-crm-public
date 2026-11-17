-- Фото-пост в разделе свободных публикаций (16.11.2026): вид материала и список фото.
ALTER TABLE "SocialVideoPost" ADD COLUMN "mediaKind" TEXT NOT NULL DEFAULT 'VIDEO';
ALTER TABLE "SocialVideoPost" ADD COLUMN "imagePaths" TEXT[] DEFAULT ARRAY[]::TEXT[];
