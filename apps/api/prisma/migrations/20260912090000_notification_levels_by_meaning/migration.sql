-- Уровни уведомлений переведены со шкалы громкости на деление по сути дела
-- (владелец 09.09.2026, переделано 12.09.2026):
--   URGENT/HIGH/NORMAL/LOW  ->  APPROVAL/CRITICAL/INSIGHT/OTHER
--
-- Старое «Срочное» (URGENT) по смыслу совпадает с «Критичным»: туда помечались
-- алармы, на которых теряют клиента. Остальные три ступени громкости не несли
-- различия, которое можно перенести, — они уходят в «Прочее», а верные уровни
-- проставятся заново при следующем событии по тому же поводу (upsertByTag).
UPDATE "Notification" SET "level" = 'CRITICAL' WHERE "level" = 'URGENT';
UPDATE "Notification" SET "level" = 'OTHER'    WHERE "level" IN ('HIGH', 'NORMAL', 'LOW');
UPDATE "PendingDirectorAlert" SET "level" = 'CRITICAL' WHERE "level" = 'URGENT';
UPDATE "PendingDirectorAlert" SET "level" = 'OTHER'    WHERE "level" IN ('HIGH', 'NORMAL', 'LOW');

-- Умолчание столбца тоже меняется: «NORMAL» такого уровня больше нет.
ALTER TABLE "Notification" ALTER COLUMN "level" SET DEFAULT 'OTHER';
