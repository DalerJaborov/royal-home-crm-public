-- Срок жизни кода привязки Telegram и подпись «это тот же человек» (25.11.2026).
-- Обе колонки необязательные, без заполнения: существующие строки не меняются.
ALTER TABLE "Agent" ADD COLUMN "telegramLinkCodeExpiresAt" TIMESTAMP(3);
ALTER TABLE "Agent" ADD COLUMN "samePersonAgentId" TEXT;

ALTER TABLE "Agent" ADD CONSTRAINT "Agent_samePersonAgentId_fkey" FOREIGN KEY ("samePersonAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
