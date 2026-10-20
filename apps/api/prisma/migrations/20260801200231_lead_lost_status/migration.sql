-- AlterEnum
ALTER TYPE "ClientStatus" ADD VALUE 'LOST';

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "leadMaxTransfers" INTEGER NOT NULL DEFAULT 3;
