-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "lastAgentAttemptAt" TIMESTAMP(3),
ADD COLUMN     "phoneLeakedAt" TIMESTAMP(3);
