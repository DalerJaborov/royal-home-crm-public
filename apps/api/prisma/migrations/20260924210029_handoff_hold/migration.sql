-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "videoHandoffHeldAt" TIMESTAMP(3),
ADD COLUMN     "videoHandoffHeldById" TEXT,
ADD COLUMN     "videoHandoffHoldReason" TEXT;
