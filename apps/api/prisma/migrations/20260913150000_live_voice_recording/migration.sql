-- Запись звонка живого голоса (13.09.2026) — стерео WAV в R2, собранный самим
-- процессом (нет MixMonitor на канале externalMedia, см. докстринг
-- lib/telephony/liveVoiceBridge.ts::saveLiveVoiceRecording). Плюс clientId —
-- раньше был только в памяти сессии, не в базе.
-- Написано руками (см. 20260912100200_bot_pause_watch) — БД недоступна в среде агента.

ALTER TABLE "LiveVoiceSession" ADD COLUMN "clientId" TEXT;
ALTER TABLE "LiveVoiceSession" ADD COLUMN "recordingUrl" TEXT;

CREATE INDEX "LiveVoiceSession_clientId_idx" ON "LiveVoiceSession"("clientId");
