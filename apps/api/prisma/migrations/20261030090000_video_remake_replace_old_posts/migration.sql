-- Перемонтаж «заменить старые посты, когда выйдет новый» (30.10.2026).
ALTER TABLE "VideoRemakeRequest" ADD COLUMN "replaceOldPostsOnPublish" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "VideoRemakeRequest" ADD COLUMN "oldPostsReplacedAt" TIMESTAMP(3);
