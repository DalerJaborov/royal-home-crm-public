-- Живой голос: выбор поставщика слуха и голоса (Google Gemini Live / ElevenLabs).
-- По умолчанию Google — поведение до переключателя не меняется.
ALTER TABLE "Settings" ADD COLUMN "liveVoiceProvider" TEXT NOT NULL DEFAULT 'google';
ALTER TABLE "Settings" ADD COLUMN "elevenLabsAgentId" TEXT;
ALTER TABLE "Settings" ADD COLUMN "elevenLabsVoiceIdRu" TEXT;
ALTER TABLE "Settings" ADD COLUMN "elevenLabsVoiceIdTg" TEXT;
-- Пол русского голоса ElevenLabs (female/male; null — женский): нужен правилу рода
-- в промте (ai/liveVoiceSelfGender.ts) — по voice id пол не узнать.
ALTER TABLE "Settings" ADD COLUMN "elevenLabsVoiceGender" TEXT;
-- Ключ хранится зашифрованным (encryptSecret), как остальные ключи ИИ.
ALTER TABLE "Settings" ADD COLUMN "elevenLabsApiKey" TEXT;
