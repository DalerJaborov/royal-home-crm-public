-- CreateEnum
CREATE TYPE "PropertyAutoMontageStatus" AS ENUM ('NONE', 'PROCESSING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "autoMontageError" TEXT,
ADD COLUMN     "autoMontageStatus" "PropertyAutoMontageStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "autoMontageUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "autoMontageUrl" TEXT,
ADD COLUMN     "postApprovedAt" TIMESTAMP(3),
ADD COLUMN     "publishedChannels" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "autoMontageEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoPublishEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "telegramChannelId" TEXT;

