-- Предложение объекта коллеге для его клиента (10.11.2026, мастер объекта в Telegram).
-- Аддитивно: новая таблица, существующие строки не трогаются.
-- CreateTable
CREATE TABLE "PropertyClientOffer" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "fromAgentId" TEXT NOT NULL,
    "toAgentId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropertyClientOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PropertyClientOffer_toAgentId_createdAt_idx" ON "PropertyClientOffer"("toAgentId", "createdAt");

-- CreateIndex
CREATE INDEX "PropertyClientOffer_clientId_idx" ON "PropertyClientOffer"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyClientOffer_propertyId_clientId_key" ON "PropertyClientOffer"("propertyId", "clientId");

-- AddForeignKey
ALTER TABLE "PropertyClientOffer" ADD CONSTRAINT "PropertyClientOffer_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyClientOffer" ADD CONSTRAINT "PropertyClientOffer_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyClientOffer" ADD CONSTRAINT "PropertyClientOffer_fromAgentId_fkey" FOREIGN KEY ("fromAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyClientOffer" ADD CONSTRAINT "PropertyClientOffer_toAgentId_fkey" FOREIGN KEY ("toAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
