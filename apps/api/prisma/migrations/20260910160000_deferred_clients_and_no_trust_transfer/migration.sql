-- AlterEnum
ALTER TYPE "WorkStatus" ADD VALUE 'DEFERRED';

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "deferredAt" TIMESTAMP(3),
ADD COLUMN     "deferredReason" TEXT,
ADD COLUMN     "deferredUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Client_workStatus_deferredUntil_idx" ON "Client"("workStatus", "deferredUntil");
