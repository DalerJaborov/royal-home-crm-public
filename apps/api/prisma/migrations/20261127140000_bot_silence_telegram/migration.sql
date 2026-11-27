-- Сторож «бот замолчал»: то же уведомление директору и администратору ещё и в Telegram (владелец 27.11.2026).
-- Только добавляет колонку, ВКЛ по умолчанию; существующие данные не меняются.
ALTER TABLE "Settings" ADD COLUMN "botSilenceTelegramEnabled" BOOLEAN NOT NULL DEFAULT true;
