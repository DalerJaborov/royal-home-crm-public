-- Консультант говорит по-таджикски и по-русски, по языку клиента (24.09.2026,
-- робозвонок, правка 6; решение Dan). Замок «только русский» снимается и у
-- действующих настроек: он был временной диагностикой акцента (12.09.2026).
ALTER TABLE "Settings" ALTER COLUMN "liveVoiceForceRussianOnly" SET DEFAULT false;
UPDATE "Settings" SET "liveVoiceForceRussianOnly" = false;
