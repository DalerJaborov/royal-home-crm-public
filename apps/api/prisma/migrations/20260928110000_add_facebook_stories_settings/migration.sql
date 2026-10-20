-- Сторис Facebook (Page Stories API) + ежедневная подборка сторис (28.09.2026, решение владельца).
ALTER TABLE "Settings" ADD COLUMN "facebookStoriesEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "dailyStoriesEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "dailyStoriesCount" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "Settings" ADD COLUMN "dailyStoriesHourDushanbe" INTEGER NOT NULL DEFAULT 11;
ALTER TABLE "Settings" ADD COLUMN "dailyStoriesLastRunAt" TIMESTAMP(3);
