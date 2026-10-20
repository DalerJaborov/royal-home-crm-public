-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "poolCandidateIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
