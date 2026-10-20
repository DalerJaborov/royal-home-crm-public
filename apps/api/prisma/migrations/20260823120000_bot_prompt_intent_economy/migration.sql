-- Экономия промта по намерению (тумблер владельца от 23.08.2026).
-- ВЫКЛЮЧЕНА по умолчанию: пока значение false, бот собирает системный промт
-- ровно так же, как до этой миграции, побайтово.
ALTER TABLE "Settings" ADD COLUMN     "botPromptIntentEconomy" BOOLEAN NOT NULL DEFAULT false;
