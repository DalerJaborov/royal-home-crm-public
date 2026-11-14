-- Журнал сообщений помощницы уходит вместе с сотрудником (ревью 11.11.2026).
-- Таблица новая (20261110180000_staff_notice); осиротевшие строки убираем до
-- ключа, чтобы ADD CONSTRAINT не упал.
DELETE FROM "StaffNotice" WHERE "agentId" NOT IN (SELECT "id" FROM "Agent");

ALTER TABLE "StaffNotice" ADD CONSTRAINT "StaffNotice_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- «Посты в Telegram» (Agent.sharePostTelegram) и вид «Публикации объектов» —
-- одна настройка, источник — Agent.pushMuted. Кто снял флаг раньше — тот же
-- выбор переносится в pushMuted (флаг остаётся зеркалом для экрана команды).
UPDATE "Agent" SET "pushMuted" = array_append("pushMuted", 'publication')
WHERE "sharePostTelegram" = false AND NOT ('publication' = ANY("pushMuted"));
