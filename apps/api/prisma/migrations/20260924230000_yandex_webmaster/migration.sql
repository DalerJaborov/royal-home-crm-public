-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "yandexWebmasterClientId" TEXT,
ADD COLUMN     "yandexWebmasterClientSecret" TEXT,
ADD COLUMN     "yandexWebmasterConnectedAt" TIMESTAMP(3),
ADD COLUMN     "yandexWebmasterHostId" TEXT,
ADD COLUMN     "yandexWebmasterRefreshToken" TEXT,
ADD COLUMN     "yandexWebmasterUserId" TEXT;
