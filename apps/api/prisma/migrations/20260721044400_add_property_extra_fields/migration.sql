-- CreateEnum
CREATE TYPE "PropertyStage" AS ENUM ('BUILT', 'UNDER_CONSTRUCTION', 'FOUNDATION');

-- CreateEnum
CREATE TYPE "MarketType" AS ENUM ('NEW_BUILD', 'SECONDARY');

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "stage" "PropertyStage",
ADD COLUMN     "marketType" "MarketType",
ADD COLUMN     "urgent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "details" JSONB,
ADD COLUMN     "metaTitle" TEXT,
ADD COLUMN     "metaDescription" TEXT,
ADD COLUMN     "h1" TEXT,
ADD COLUMN     "seoDesc" TEXT;
