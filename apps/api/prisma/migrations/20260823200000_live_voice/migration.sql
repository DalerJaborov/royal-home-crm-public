-- Живой голос (пункт 5 очереди ИИ, 23.08.2026): бот разговаривает с клиентом по
-- телефону через Gemini Live API вместо текстовых реплик. Выключено по умолчанию —
-- звук не проверить тестами, единственная проверка — реальный звонок на живую
-- станцию, которого ещё не было (см. apps/api/src/lib/telephony/liveVoiceBridge.ts).
--
-- Изоляция от обычной маршрутизации звонков: тумблер только открывает второе,
-- независимое ARI-подключение (app=royalhome-live-voice) — from-internal, очередь
-- 1000 и остальная телефония агентства этой миграцией не затрагиваются никак.
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "liveVoiceEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "liveVoiceTestExtension" TEXT;

-- Черновой журнал сессий живого голоса — отдельно от Interaction/CallAnalysis
-- (обе требуют известного clientId/agentId, которых у звонка на тестовый номер нет).
CREATE TABLE IF NOT EXISTS "LiveVoiceSession" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "transcript" TEXT,
    "endedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveVoiceSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "LiveVoiceSession_channelId_key" ON "LiveVoiceSession"("channelId");
