-- Журнал помощницы: одна строка на ход и срок хранения (пачка 2, 07.11.2026).
-- Аддитивно: новая таблица и новая колонка настроек со значением по умолчанию;
-- ни одна существующая строка не переписывается и не удаляется.

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "aiAssistantLogRetentionDays" INTEGER NOT NULL DEFAULT 90;
ALTER TABLE "Settings" ADD COLUMN "aiAssistantMaxRounds" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Settings" ADD COLUMN "aiAssistantDeadlineSec" INTEGER NOT NULL DEFAULT 120;

-- CreateTable
CREATE TABLE "AiAssistantTurnLog" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "surface" TEXT,
    "question" TEXT,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "route" TEXT NOT NULL,
    "rounds" INTEGER NOT NULL,
    "toolCalls" INTEGER NOT NULL,
    "replyChars" INTEGER,
    "ms" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAssistantTurnLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiAssistantTurnLog_createdAt_idx" ON "AiAssistantTurnLog"("createdAt");

-- CreateIndex
CREATE INDEX "AiAssistantTurnLog_agentId_createdAt_idx" ON "AiAssistantTurnLog"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "AiAssistantTurnLog_outcome_createdAt_idx" ON "AiAssistantTurnLog"("outcome", "createdAt");

-- AddForeignKey
ALTER TABLE "AiAssistantTurnLog" ADD CONSTRAINT "AiAssistantTurnLog_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
