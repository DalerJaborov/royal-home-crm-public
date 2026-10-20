-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "photosApprovedAt" TIMESTAMP(3),
ADD COLUMN     "photosRejectionCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reviewRejectionReason" TEXT,
ADD COLUMN     "videoApprovedAt" TIMESTAMP(3),
ADD COLUMN     "videoRejectionCount" INTEGER NOT NULL DEFAULT 0;

