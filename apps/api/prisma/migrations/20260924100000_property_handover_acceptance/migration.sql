-- Передача объекта другому агенту с принятием новым хозяином (владелец 24.09.2026).
-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "handoverPendingSince" TIMESTAMP(3),
ADD COLUMN     "handoverFromAgentId" TEXT,
ADD COLUMN     "handoverReason" TEXT;

-- CreateIndex
CREATE INDEX "Property_handoverPendingSince_idx" ON "Property"("handoverPendingSince");

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_handoverFromAgentId_fkey" FOREIGN KEY ("handoverFromAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
