-- Управление живым голосом из интерфейса (13.09.2026) — полная замена личности
-- (как у botSystemPrompt текстового бота), выбор голоса и настройка замка на
-- русский, который раньше можно было снять только через .env на сервере.
-- Написано руками (см. 20260912100200_bot_pause_watch — тот же приём: prisma
-- generate в изолированной среде без доступной базы, сверено со schema.prisma).

ALTER TABLE "Settings" ADD COLUMN "liveVoicePrompt" TEXT;
ALTER TABLE "Settings" ADD COLUMN "liveVoiceVoiceName" TEXT;
ALTER TABLE "Settings" ADD COLUMN "liveVoiceForceRussianOnly" BOOLEAN NOT NULL DEFAULT true;

-- Звуковое оформление (шум/щелчки/вдох). Громкость шума поднята втрое против
-- исходных зашитых чисел (90/160) — живой звонок владельца 13.09.2026 сразу
-- после выката показал, что прежний уровень не слышен вовсе на реальной
-- телефонной линии (ulaw/8кГц компандирует тихие сигналы).
ALTER TABLE "Settings" ADD COLUMN "liveVoiceAmbientNoiseDuringSpeech" INTEGER NOT NULL DEFAULT 280;
ALTER TABLE "Settings" ADD COLUMN "liveVoiceAmbientNoiseDuringSilence" INTEGER NOT NULL DEFAULT 480;
ALTER TABLE "Settings" ADD COLUMN "liveVoiceTypingClickEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "liveVoiceBreathEnabled" BOOLEAN NOT NULL DEFAULT true;
