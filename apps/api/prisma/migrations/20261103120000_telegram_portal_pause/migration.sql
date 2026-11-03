-- Пауза Telegram-уведомлений с площадок Somon/Paydo: по умолчанию включена (03.11.2026).
ALTER TABLE "Settings" ADD COLUMN "telegramPortalAlertsPaused" BOOLEAN NOT NULL DEFAULT true;
