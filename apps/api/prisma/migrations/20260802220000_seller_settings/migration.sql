-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "sellerMaxQuestions" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "sellerNotSelling" TEXT NOT NULL DEFAULT 'Земля и участки',
ADD COLUMN     "sellerAdvantages" TEXT NOT NULL DEFAULT '';
