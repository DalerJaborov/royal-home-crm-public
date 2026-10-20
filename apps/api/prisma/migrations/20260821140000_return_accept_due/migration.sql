-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "returnAcceptDueAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Client_returnAcceptDueAt_idx" ON "Client"("returnAcceptDueAt");
