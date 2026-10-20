-- Пачка 14, 11.09.2026: документы сделки (чек-лист перед закрытием) и факт
-- выплаты комиссии агенту (docs/agent-briefs/ownership-security-11-09.md, Пачка 14).

-- CreateEnum
CREATE TYPE "DealDocumentKind" AS ENUM ('OWNERSHIP', 'CONTRACT', 'PASSPORT', 'RECEIPT', 'OTHER');

-- AlterTable: факт выплаты комиссии риелтору
ALTER TABLE "Deal"
  ADD COLUMN "realtorPayoutAt" TIMESTAMP(3),
  ADD COLUMN "realtorPayoutById" TEXT,
  ADD COLUMN "realtorPayoutNote" TEXT;

-- AlterTable: чек-лист обязательных документов сделки. Дефолт — пустой список
-- (гейт выключен, пока владелец сам не выберет документы в Настройках); было
-- ARRAY['OWNERSHIP','CONTRACT'], исправлено 11.09.2026 — включённый по умолчанию
-- гейт ломал штатное закрытие сделок без документов.
ALTER TABLE "Settings"
  ADD COLUMN "dealRequiredDocuments" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "DealDocument" (
  "id" TEXT NOT NULL,
  "dealId" TEXT NOT NULL,
  "kind" "DealDocumentKind" NOT NULL,
  "fileName" TEXT NOT NULL,
  "originalName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "uploadedById" TEXT NOT NULL,
  "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DealDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DealDocument_dealId_idx" ON "DealDocument"("dealId");

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_realtorPayoutById_fkey" FOREIGN KEY ("realtorPayoutById") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealDocument" ADD CONSTRAINT "DealDocument_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealDocument" ADD CONSTRAINT "DealDocument_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
