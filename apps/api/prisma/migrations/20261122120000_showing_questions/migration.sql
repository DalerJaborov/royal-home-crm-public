-- Вопросы агенту о показе (22.11.2026): «Договорились о показе?» и «У вас был показ?». Только добавляет: таблица и два рубильника (ВКЛ).
ALTER TABLE "Settings" ADD COLUMN "showingAgreementAskEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "showingOutcomeAskEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "ShowingQuestion" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "showingId" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "proposedAt" TIMESTAMP(3),
    "propertyId" TEXT,
    "quote" TEXT,
    "askAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "answer" TEXT,
    "answeredVia" TEXT,
    "answeredById" TEXT,
    "answeredAt" TIMESTAMP(3),
    "telegramSentAt" TIMESTAMP(3),
    "telegramChatId" TEXT,
    "telegramMessageId" INTEGER,
    "pushSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShowingQuestion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShowingQuestion_dedupKey_key" ON "ShowingQuestion"("dedupKey");
CREATE INDEX "ShowingQuestion_status_askAt_idx" ON "ShowingQuestion"("status", "askAt");
CREATE INDEX "ShowingQuestion_agentId_status_idx" ON "ShowingQuestion"("agentId", "status");
CREATE INDEX "ShowingQuestion_clientId_status_idx" ON "ShowingQuestion"("clientId", "status");
