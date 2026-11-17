-- 31.10.2026, П2 задача 2.3: действия ИИ-помощника с подтверждением (AssistantAction).
-- Безопасно для прода: только НОВЫЙ тип и НОВАЯ таблица с индексами на пустой
-- таблице; существующие таблицы не меняются и не блокируются (нет FK на Agent).
-- CreateEnum
CREATE TYPE "AssistantActionStatus" AS ENUM ('PENDING', 'CONFIRMED', 'EXECUTED', 'FAILED', 'CANCELLED', 'EXPIRED', 'UNDONE');

-- CreateTable
CREATE TABLE "AssistantAction" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'crm',
    "tool" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "argsHash" TEXT NOT NULL,
    "preview" JSONB NOT NULL,
    "snapshotBefore" JSONB NOT NULL,
    "snapshotAfter" JSONB,
    "status" "AssistantActionStatus" NOT NULL DEFAULT 'PENDING',
    "statusReason" TEXT,
    "idempotencyKey" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "result" JSONB,
    "undoClaimedAt" TIMESTAMP(3),
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AssistantAction_idempotencyKey_key" ON "AssistantAction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AssistantAction_agentId_createdAt_idx" ON "AssistantAction"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "AssistantAction_status_expiresAt_idx" ON "AssistantAction"("status", "expiresAt");
