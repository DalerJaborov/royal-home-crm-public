-- Модерация в Telegram (22.09.2026). Только новые таблицы и одна колонка с умолчанием.
ALTER TABLE "Agent" ADD COLUMN "telegramModeration" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "TelegramModerationMessage" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "batchId" TEXT,
    "agentId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "propertyVersion" INTEGER NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TelegramModerationMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TelegramModerationMessage_propertyId_resolvedAt_idx" ON "TelegramModerationMessage"("propertyId", "resolvedAt");
CREATE INDEX "TelegramModerationMessage_batchId_idx" ON "TelegramModerationMessage"("batchId");

CREATE TABLE "TelegramPhotoBatch" (
    "id" TEXT NOT NULL,
    "shortCode" SERIAL NOT NULL,
    "propertyId" TEXT NOT NULL,
    "photoIds" TEXT[],
    "decisions" JSONB NOT NULL DEFAULT '{}',
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TelegramPhotoBatch_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TelegramPhotoBatch_shortCode_key" ON "TelegramPhotoBatch"("shortCode");
CREATE INDEX "TelegramPhotoBatch_propertyId_idx" ON "TelegramPhotoBatch"("propertyId");

CREATE TABLE "TelegramDialogState" (
    "chatId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TelegramDialogState_pkey" PRIMARY KEY ("chatId")
);

CREATE TABLE "TelegramCallbackSeen" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TelegramCallbackSeen_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TelegramCallbackSeen_createdAt_idx" ON "TelegramCallbackSeen"("createdAt");
