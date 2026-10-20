/*
  Warnings:

  - You are about to drop the column `createLead` on the `LeadMagnetCampaign` table. All the data in the column will be lost.
  - You are about to drop the column `clientId` on the `LeadMagnetDelivery` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "LeadMagnetCampaign" DROP COLUMN "createLead",
ADD COLUMN     "handoffToBot" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "LeadMagnetDelivery" DROP COLUMN "clientId";
