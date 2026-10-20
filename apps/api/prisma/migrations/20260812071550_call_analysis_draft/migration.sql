-- DropIndex
DROP INDEX "Client_fullName_trgm_idx";

-- DropIndex
DROP INDEX "Property_address_trgm_idx";

-- DropIndex
DROP INDEX "Property_title_trgm_idx";

-- AlterTable
ALTER TABLE "CallAnalysis" ADD COLUMN     "suggestedNextAction" TEXT,
ADD COLUMN     "suggestedOutcome" TEXT;
