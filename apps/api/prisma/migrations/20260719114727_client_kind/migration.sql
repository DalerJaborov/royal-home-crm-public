-- CreateEnum
CREATE TYPE "ClientKind" AS ENUM ('BUYER', 'SELLER');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "kind" "ClientKind" NOT NULL DEFAULT 'BUYER';
