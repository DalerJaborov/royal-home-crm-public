-- Второе «я подписался» считается словом человека и открывает выдачу файла.
-- По умолчанию выключено: прежнее требование владельца «без подписки не выдавать»
-- остаётся в силе, пока переключатель не включат осознанно.
-- AlterTable
ALTER TABLE "LeadMagnetCampaign" ADD COLUMN "deliverOnSecondClaim" BOOLEAN NOT NULL DEFAULT false;
