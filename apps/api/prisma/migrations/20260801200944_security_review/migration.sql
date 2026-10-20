-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "securityNote" TEXT,
ADD COLUMN     "securityReview" TEXT,
ADD COLUMN     "securityReviewedAt" TIMESTAMP(3),
ADD COLUMN     "securityReviewedById" TEXT;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_securityReviewedById_fkey" FOREIGN KEY ("securityReviewedById") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
