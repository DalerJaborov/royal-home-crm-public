-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "documents" TEXT,
ADD COLUMN     "listingAcceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
