-- TikTok Content Posting API (17.09.2026) — пятый канал автопубликации, рядом
-- с youtube*. Все колонки NULL/DEFAULT — существующая строка Settings.singleton
-- продолжает работать без миграции данных. См. docs/agent-briefs/tiktok-content-posting-17-09.md.
ALTER TABLE "Settings" ADD COLUMN "tiktokClientKey" TEXT;
ALTER TABLE "Settings" ADD COLUMN "tiktokClientSecret" TEXT;
ALTER TABLE "Settings" ADD COLUMN "tiktokRefreshToken" TEXT;
ALTER TABLE "Settings" ADD COLUMN "tiktokOpenId" TEXT;
ALTER TABLE "Settings" ADD COLUMN "tiktokCreatorUsername" TEXT;
ALTER TABLE "Settings" ADD COLUMN "tiktokCreatorNickname" TEXT;
ALTER TABLE "Settings" ADD COLUMN "tiktokCreatorAvatarUrl" TEXT;
ALTER TABLE "Settings" ADD COLUMN "tiktokConnectedAt" TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN "tiktokPrivacyLevel" TEXT;
ALTER TABLE "Settings" ADD COLUMN "tiktokAllowComments" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "tiktokAllowDuet" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "tiktokAllowStitch" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "tiktokBrandMode" TEXT NOT NULL DEFAULT 'NONE';
