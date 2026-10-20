-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'DIRECTOR';

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "preferences" JSONB;
