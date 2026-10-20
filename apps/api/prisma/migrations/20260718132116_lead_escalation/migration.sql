-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "escalatedAt" TIMESTAMP(3),
ADD COLUMN     "reassignCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "leadEscalateAfter" INTEGER NOT NULL DEFAULT 3;

-- CreateIndex
CREATE INDEX "Client_escalatedAt_idx" ON "Client"("escalatedAt");
