-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "hotSince" TIMESTAMP(3),
ADD COLUMN     "refusalCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refusalReason" TEXT;
