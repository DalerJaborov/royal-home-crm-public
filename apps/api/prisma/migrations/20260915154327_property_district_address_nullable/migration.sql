-- DropForeignKey
ALTER TABLE "Property" DROP CONSTRAINT "Property_districtId_fkey";

-- AlterTable
ALTER TABLE "Property" ALTER COLUMN "districtId" DROP NOT NULL,
ALTER COLUMN "address" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "District"("id") ON DELETE SET NULL ON UPDATE CASCADE;
