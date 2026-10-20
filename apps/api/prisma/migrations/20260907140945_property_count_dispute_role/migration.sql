-- AlterTable
ALTER TABLE "PropertyCountDispute" ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'SELLER';

-- CreateIndex
CREATE INDEX "PropertyCountDispute_clientId_role_status_idx" ON "PropertyCountDispute"("clientId", "role", "status");
