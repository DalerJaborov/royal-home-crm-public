-- «Бот отвечает всегда», вторая волна (15.11.2026): рубильники двух новых сторожей.
-- Telegram: клиент без ответа 30 минут — пуш ответственному (lib/clientWaitingAlert.ts).
-- Telegram: доставка в CRM сломалась (getWebhookInfo) — тревога руководству (lib/telegramDeliveryWatch.ts).
-- WhatsApp: вебхук замолчал при живом номере — тревога руководству (lib/whatsappWebhookWatch.ts).
ALTER TABLE "Settings" ADD COLUMN "telegramSilenceWatchEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "whatsappWebhookWatchEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "telegramDeliveryWatchEnabled" BOOLEAN NOT NULL DEFAULT true;
