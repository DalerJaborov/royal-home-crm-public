-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "desiredAreaMin" INTEGER,
ADD COLUMN     "desiredFloorMax" INTEGER,
ADD COLUMN     "desiredFloorMin" INTEGER,
ADD COLUMN     "desiredTotalFloors" INTEGER;

-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "windowCount" INTEGER;

-- AlterTable
ALTER TABLE "Settings" ALTER COLUMN "leadActiveLimit" SET DEFAULT 6;
