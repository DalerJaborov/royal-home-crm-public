-- Уведомление о входящем звонке и часы приёма (решение владельца 11.08.2026:
-- «на мобильном, даже если CRM на айфоне закрыт, звонки должны прийти»).
--
-- Идемпотентно (IF NOT EXISTS) по той же причине, что и миграция входящих от
-- 10.08.2026: `migrate deploy` на этом проекте уже падал с deadlock 40P01 из-за
-- параллельной сессии, и лечением был повтор той же миграции.

-- Уведомление о звонке на телефон оператора. Включено: окно оператора живёт
-- только в открытой вкладке, и без уведомления возможность не работает у того,
-- кто держит телефон в кармане, — то есть у оператора.
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "incomingPushEnabled" BOOLEAN NOT NULL DEFAULT true;

-- Часы приёма ВЫКЛЮЧЕНЫ по умолчанию — то есть круглосуточно, ровно прежнее
-- поведение. Настройка, приехавшая на прод уже что-то запрещающей, тихо ломает
-- работу тому, кто её не заказывал.
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "incomingHoursEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "incomingHoursStart" TEXT NOT NULL DEFAULT '09:00';
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "incomingHoursEnd" TEXT NOT NULL DEFAULT '21:00';
