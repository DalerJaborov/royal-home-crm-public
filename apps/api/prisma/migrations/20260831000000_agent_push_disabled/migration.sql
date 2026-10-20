-- Полное отключение push на все устройства сотрудника, отдельно от pushMuted
-- (звонки идут без kind и не ловятся поштучным списком). Решение владельца
-- 31.08.2026 — админу и директору, у кого звонки и так приходят на прямой SIP.
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "pushDisabled" BOOLEAN NOT NULL DEFAULT false;
