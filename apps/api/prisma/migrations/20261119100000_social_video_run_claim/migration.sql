-- Бронь исполнителя публикации свободного ролика (защита от двойной публикации между процессами).
ALTER TABLE "SocialVideoPost" ADD COLUMN "runClaimedAt" TIMESTAMP(3), ADD COLUMN "runClaimedBy" TEXT;
