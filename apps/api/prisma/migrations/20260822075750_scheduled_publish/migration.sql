-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "scheduledPublishAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Property_scheduledPublishAt_idx" ON "Property"("scheduledPublishAt");

