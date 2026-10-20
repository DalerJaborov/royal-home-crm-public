-- CreateEnum
CREATE TYPE "ClipReviewStatus" AS ENUM ('NONE', 'PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "clipReviewTelegram" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "clipReviewComment" TEXT,
ADD COLUMN     "clipReviewDecidedAt" TIMESTAMP(3),
ADD COLUMN     "clipReviewDecidedById" TEXT,
ADD COLUMN     "clipReviewRequestedAt" TIMESTAMP(3),
ADD COLUMN     "clipReviewStatus" "ClipReviewStatus" NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "clipReviewEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rawReviewRequired" BOOLEAN NOT NULL DEFAULT true;
