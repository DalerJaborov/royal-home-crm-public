-- Чистка шума (владелец 28.11.2026): скрытие уведомления у сотрудника и автоочистка с рубильником.
-- Только добавляет колонки: данные не трогаются. Автоочистка ВЫКЛ по умолчанию.
ALTER TABLE "Notification" ADD COLUMN "hiddenAt" TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN "autoCleanupEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "autoCleanupNotificationsReadDays" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Settings" ADD COLUMN "autoCleanupErrorsResolvedDays" INTEGER NOT NULL DEFAULT 14;
ALTER TABLE "Settings" ADD COLUMN "autoCleanupAiLogDays" INTEGER NOT NULL DEFAULT 14;
ALTER TABLE "Settings" ADD COLUMN "autoCleanupDirectorAlertsDays" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Settings" ADD COLUMN "autoCleanupBotCountersDays" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Settings" ADD COLUMN "autoCleanupOneTimeDays" INTEGER NOT NULL DEFAULT 7;
