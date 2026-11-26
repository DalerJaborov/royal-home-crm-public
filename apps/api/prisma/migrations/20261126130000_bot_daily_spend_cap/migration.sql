-- Суточный денежный потолок бота клиентов (CRM-47, 26.11.2026): рубильник ВЫКЛ (включает владелец, выбрав сумму), сумма 5 USD предложена. Только новые колонки.
ALTER TABLE "Settings" ADD COLUMN "botDailySpendCapEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "botDailySpendCapUsd" DOUBLE PRECISION NOT NULL DEFAULT 5;
