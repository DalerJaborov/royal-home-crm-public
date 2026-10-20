-- Первое сообщение клиенту в WhatsApp одобренным Meta текстом (24.09.2026).
ALTER TABLE "Settings" ADD COLUMN "metaWaBusinessAccountId" TEXT;

CREATE TABLE "WhatsAppFirstContact" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "conversationId" TEXT,
    "recipient" TEXT NOT NULL,
    "propertyId" TEXT,
    "templateName" TEXT NOT NULL,
    "waMessageId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "failReason" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "repliedAt" TIMESTAMP(3),

    CONSTRAINT "WhatsAppFirstContact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhatsAppFirstContact_waMessageId_key" ON "WhatsAppFirstContact"("waMessageId");
CREATE INDEX "WhatsAppFirstContact_clientId_sentAt_idx" ON "WhatsAppFirstContact"("clientId", "sentAt");
CREATE INDEX "WhatsAppFirstContact_recipient_repliedAt_idx" ON "WhatsAppFirstContact"("recipient", "repliedAt");
