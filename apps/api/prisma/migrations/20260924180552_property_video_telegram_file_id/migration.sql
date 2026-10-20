-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "videoHandoffDispatchStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PropertyVideo" ADD COLUMN     "telegramDeliveredAt" TIMESTAMP(3),
ADD COLUMN     "telegramFileId" TEXT,
ADD COLUMN     "telegramFileUniqueId" TEXT;
