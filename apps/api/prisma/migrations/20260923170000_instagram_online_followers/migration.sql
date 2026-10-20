-- Тепловая карта: сколько подписчиков Instagram в сети по часам (суточный сбор
-- метрики online_followers) и тумблер «часы выхода роликов по Instagram».
CREATE TABLE "InstagramOnlineFollowersHour" (
    "igUserId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstagramOnlineFollowersHour_pkey" PRIMARY KEY ("igUserId","at")
);

CREATE INDEX "InstagramOnlineFollowersHour_at_idx" ON "InstagramOnlineFollowersHour"("at");

ALTER TABLE "Settings" ADD COLUMN "publishScheduleUseInstagramOnline" BOOLEAN NOT NULL DEFAULT true;
