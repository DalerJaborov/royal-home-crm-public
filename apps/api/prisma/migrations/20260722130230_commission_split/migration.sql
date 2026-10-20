-- AlterTable
ALTER TABLE "Deal" ADD COLUMN     "commissionCompanyAmount" DECIMAL(65,30),
ADD COLUMN     "commissionIntakeAmount" DECIMAL(65,30),
ADD COLUMN     "commissionRealtorAmount" DECIMAL(65,30);

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "commissionCompanyPercent" DECIMAL(65,30) NOT NULL DEFAULT 1.0,
ADD COLUMN     "commissionIntakePercent" DECIMAL(65,30) NOT NULL DEFAULT 0.5,
ADD COLUMN     "commissionRealtorPercent" DECIMAL(65,30) NOT NULL DEFAULT 0.5;
