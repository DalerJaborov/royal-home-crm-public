-- AlterEnum
ALTER TYPE "ClientKind" ADD VALUE 'OTHER';

-- DropForeignKey
ALTER TABLE "Client" DROP CONSTRAINT "Client_assignedAgentId_fkey";

-- AlterTable
ALTER TABLE "Client" ALTER COLUMN "assignedAgentId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
