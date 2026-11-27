-- Отчёты акционеру и Telegram-бот только для сотрудников (27.11.2026, владелец).
-- Только добавляют колонки; оба рубильника ВКЛ, переключает человек в Настройках.
ALTER TABLE "Settings" ADD COLUMN "shareholderReportsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "telegramStaffOnlyEnabled" BOOLEAN NOT NULL DEFAULT true;
