-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "facebookCrosspostPageIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
