-- Настоящий офисный амбиент вместо/поверх синтетического шума живого голоса
-- (см. liveVoicePersona.ts / liveVoiceBridge.ts, разбор 14.09.2026).
ALTER TABLE "Settings" ADD COLUMN "liveVoiceOfficeAmbienceEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "liveVoiceOfficeAmbienceVolume" DOUBLE PRECISION NOT NULL DEFAULT 0.35;
