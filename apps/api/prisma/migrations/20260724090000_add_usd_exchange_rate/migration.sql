-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "usdToTjsRate" DECIMAL(65,30),
ADD COLUMN     "usdToTjsRateSource" TEXT,
ADD COLUMN     "usdToTjsRateUpdatedAt" TIMESTAMP(3);
