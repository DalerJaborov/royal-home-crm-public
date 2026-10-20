-- AlterTable
ALTER TABLE "PropertyPhoto" ADD COLUMN     "enhancedRequestedAt" TIMESTAMP(3),
ADD COLUMN     "enhancedRequestedBy" TEXT,
ADD COLUMN     "enhancedThumbUrl" TEXT,
ADD COLUMN     "enhancedUrl" TEXT,
ADD COLUMN     "originalThumbUrl" TEXT,
ADD COLUMN     "originalUrl" TEXT;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "propertyPhotoEnhanceEnabled" BOOLEAN NOT NULL DEFAULT false;
