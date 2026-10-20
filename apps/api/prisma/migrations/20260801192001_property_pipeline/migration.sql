-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PropertyStatus" ADD VALUE 'PENDING_REVIEW';
ALTER TYPE "PropertyStatus" ADD VALUE 'AWAITING_PHOTOS';
ALTER TYPE "PropertyStatus" ADD VALUE 'AWAITING_VIDEO';
ALTER TYPE "PropertyStatus" ADD VALUE 'EDITING';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'MARKETING';
ALTER TYPE "Role" ADD VALUE 'EDITOR';
ALTER TYPE "Role" ADD VALUE 'SECURITY';

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "propertyEditingDays" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "propertyPhotoDays" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "propertyReviewDays" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "propertyVideoDays" INTEGER NOT NULL DEFAULT 2;
