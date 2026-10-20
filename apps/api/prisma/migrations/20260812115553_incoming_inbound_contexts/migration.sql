-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "incomingInboundContexts" TEXT[] DEFAULT ARRAY[]::TEXT[];
