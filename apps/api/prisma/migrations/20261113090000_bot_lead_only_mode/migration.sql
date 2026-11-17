-- Режим бота «только заявки» (владелец 12–13.11.2026). Только добавление колонок
-- с безопасными значениями: сам режим ВЫКЛЮЧЕН и для новой, и для существующей
-- строки Settings, поэтому поведение бота после выката не меняется, пока владелец
-- не включит режим на экране «Бот». Остальные три значения действуют только
-- внутри включённого режима.
ALTER TABLE "Settings" ADD COLUMN "botLeadOnlyMode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "botUseWhatsappNumber" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "botMaxPhoneAsks" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "Settings" ADD COLUMN "botHotIntentHandover" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD CONSTRAINT "Settings_botMaxPhoneAsks_range" CHECK ("botMaxPhoneAsks" BETWEEN 1 AND 3);
