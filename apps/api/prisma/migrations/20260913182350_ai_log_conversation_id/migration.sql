-- AlterTable
ALTER TABLE "AiLog" ADD COLUMN     "conversationId" TEXT;

-- CreateIndex
CREATE INDEX "AiLog_conversationId_idx" ON "AiLog"("conversationId");
