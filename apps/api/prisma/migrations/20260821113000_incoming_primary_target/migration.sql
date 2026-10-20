-- Куда идёт входящий звонок в первую очередь: очередь операторов (как было)
-- или прямо на SIP-аппарат. Решение владельца 21.08.2026.
-- IF NOT EXISTS — потому что migrate deploy на этой базе уже падал с deadlock,
-- и лечение там безопасный повтор миграции.
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "incomingPrimaryTarget" TEXT NOT NULL DEFAULT 'queue';
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "incomingPrimaryExtension" TEXT;
