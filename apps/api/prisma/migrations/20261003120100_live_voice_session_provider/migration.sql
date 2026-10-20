-- Кто слышал и говорил за робота в каждом звонке (Google / ElevenLabs) —
-- владелец сравнивает поставщиков по записям. Null — звонки до правки.
ALTER TABLE "LiveVoiceSession" ADD COLUMN "provider" TEXT;
