-- AlterTable
ALTER TABLE "RoyalScoreEvent" ALTER COLUMN "delta" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "royalScoreEventPoints" JSONB,
ADD COLUMN     "royalScoreStartingScore" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "royalScoreWindowDays" INTEGER NOT NULL DEFAULT 30;

