-- Требовать подписку на ВСЕ наши аккаунты Instagram, а не только на тот, под чьим
-- постом человек написал. Выключено по умолчанию: барьер строже прежнего.
-- AlterTable
ALTER TABLE "LeadMagnetCampaign" ADD COLUMN "requireFollowAll" BOOLEAN NOT NULL DEFAULT false;
