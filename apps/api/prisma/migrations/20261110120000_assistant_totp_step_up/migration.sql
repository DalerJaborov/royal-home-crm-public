-- Помощница в Telegram: подтверждение кодом Google Authenticator (10.11.2026).
CREATE TABLE "AssistantStepUpChallenge" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'confirm',
    "bundleId" TEXT NOT NULL,
    "cardMessageId" INTEGER,
    "promptMessageId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "usedStep" INTEGER,
    "language" TEXT NOT NULL DEFAULT 'ru',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantStepUpChallenge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AssistantStepUpChallenge_agentId_usedStep_key" ON "AssistantStepUpChallenge"("agentId", "usedStep");
CREATE INDEX "AssistantStepUpChallenge_chatId_status_idx" ON "AssistantStepUpChallenge"("chatId", "status");
CREATE INDEX "AssistantStepUpChallenge_agentId_createdAt_idx" ON "AssistantStepUpChallenge"("agentId", "createdAt");

ALTER TABLE "AssistantStepUpChallenge" ADD CONSTRAINT "AssistantStepUpChallenge_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
