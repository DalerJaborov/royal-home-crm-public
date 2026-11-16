-- Передача объекта/клиента с подтверждением хозяина (16.11.2026). Аддитивно: новые типы, таблица, два поля настроек.
CREATE TYPE "TransferRequestKind" AS ENUM ('PROPERTY', 'CLIENT');
CREATE TYPE "TransferRequestStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DECLINED', 'EXPIRED', 'CANCELLED', 'FAILED');

CREATE TABLE "OwnershipTransferRequest" (
  "id" TEXT NOT NULL,
  "kind" "TransferRequestKind" NOT NULL,
  "status" "TransferRequestStatus" NOT NULL DEFAULT 'PENDING',
  "propertyId" TEXT,
  "clientId" TEXT,
  "fromAgentId" TEXT NOT NULL,
  "toAgentId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "resultNote" TEXT,
  "lastRemindedAt" TIMESTAMP(3),
  "remindCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OwnershipTransferRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OwnershipTransferRequest_fromAgentId_status_idx" ON "OwnershipTransferRequest"("fromAgentId", "status");
CREATE INDEX "OwnershipTransferRequest_requestedById_createdAt_idx" ON "OwnershipTransferRequest"("requestedById", "createdAt");
CREATE INDEX "OwnershipTransferRequest_status_expiresAt_idx" ON "OwnershipTransferRequest"("status", "expiresAt");

-- Один живой запрос на объект и на клиента: два РОП одновременно не создадут два (второй получит конфликт).
CREATE UNIQUE INDEX "OwnershipTransferRequest_property_pending_uniq" ON "OwnershipTransferRequest"("propertyId") WHERE "status" = 'PENDING' AND "propertyId" IS NOT NULL;
CREATE UNIQUE INDEX "OwnershipTransferRequest_client_pending_uniq" ON "OwnershipTransferRequest"("clientId") WHERE "status" = 'PENDING' AND "clientId" IS NOT NULL;

ALTER TABLE "Settings" ADD COLUMN "ownerConfirmTransferEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "ownerConfirmTransferHours" INTEGER NOT NULL DEFAULT 24;
