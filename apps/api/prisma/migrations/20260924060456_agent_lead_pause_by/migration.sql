-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "leadsPausedById" TEXT,
ADD COLUMN     "leadsPausedReason" TEXT;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_leadsPausedById_fkey" FOREIGN KEY ("leadsPausedById") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
