-- AlterTable
ALTER TABLE "LeadMagnetCampaign" ADD COLUMN     "accountId" TEXT;

-- AddForeignKey
ALTER TABLE "LeadMagnetCampaign" ADD CONSTRAINT "LeadMagnetCampaign_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MessengerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
