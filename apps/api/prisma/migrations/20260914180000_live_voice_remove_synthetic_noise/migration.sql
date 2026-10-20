-- Синтетический шум/щелчки клавиатуры живого голоса убраны целиком: настоящий
-- офисный амбиент (liveVoiceOfficeAmbienceEnabled/Volume, миграция
-- 20260914170000) уже содержит эти звуки по-настоящему — дублирование
-- искусственным гулом/щелчком стало лишним (владелец, 14.09.2026).
ALTER TABLE "Settings" DROP COLUMN "liveVoiceAmbientNoiseDuringSpeech";
ALTER TABLE "Settings" DROP COLUMN "liveVoiceAmbientNoiseDuringSilence";
ALTER TABLE "Settings" DROP COLUMN "liveVoiceTypingClickEnabled";
