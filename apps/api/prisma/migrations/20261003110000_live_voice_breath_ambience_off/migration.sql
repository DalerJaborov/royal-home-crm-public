-- Живой голос (02.10.2026, аудит моста): вдох перед репликой и офисный фон
-- по умолчанию выключены. Владелец слышал «пшш» перед ответами и неестественный
-- фон. Код обоих путей остаётся — включить можно в Настройках → Бот.
ALTER TABLE "Settings" ALTER COLUMN "liveVoiceBreathEnabled" SET DEFAULT false;
ALTER TABLE "Settings" ALTER COLUMN "liveVoiceOfficeAmbienceEnabled" SET DEFAULT false;

-- Существующую строку сбрасываем ТОЛЬКО по полю, которое владелец никогда не
-- трогал (аудит 02.10.2026, третий проход): раньше UPDATE затирал и осознанный
-- выбор «вдох/фон включён». Признак «трогал» — запись SETTINGS_UPDATE в журнале
-- действий с этим ключом в списке fields (экран шлёт один ключ на переключатель).
-- Значение true у нетронутого поля — это прежнее умолчание, его и сбрасываем.
-- Журнал действий не чистится (удаления AuditLog в коде нет), так что «нетронутое»
-- по журналу — это действительно нетронутое. Разбор: docs/journal/2026-10-02-robot3-prompts.md.
UPDATE "Settings" SET "liveVoiceBreathEnabled" = false
WHERE "liveVoiceBreathEnabled" = true
  AND NOT EXISTS (
    SELECT 1 FROM "AuditLog"
    WHERE "action" = 'SETTINGS_UPDATE'
      AND "entityType" = 'Settings'
      AND jsonb_typeof("meta"::jsonb -> 'fields') = 'array'
      AND ("meta"::jsonb -> 'fields') ? 'liveVoiceBreathEnabled'
  );
UPDATE "Settings" SET "liveVoiceOfficeAmbienceEnabled" = false
WHERE "liveVoiceOfficeAmbienceEnabled" = true
  AND NOT EXISTS (
    SELECT 1 FROM "AuditLog"
    WHERE "action" = 'SETTINGS_UPDATE'
      AND "entityType" = 'Settings'
      AND jsonb_typeof("meta"::jsonb -> 'fields') = 'array'
      AND ("meta"::jsonb -> 'fields') ? 'liveVoiceOfficeAmbienceEnabled'
  );
