-- Звонок, вернувшийся к консультанту от агента, — вторая сессия живого голоса на
-- том же канале (02.10.2026, аудит надёжности робозвонка). Уникальный индекс по
-- channelId ронял запись второй сессии; вместо него — обычный индекс для поиска
-- по каналу (сверка после перезапуска, лента опросов после показа).
DROP INDEX IF EXISTS "LiveVoiceSession_channelId_key";
CREATE INDEX IF NOT EXISTS "LiveVoiceSession_channelId_idx" ON "LiveVoiceSession"("channelId");
