-- Склейка подсказок из кусочков + список дополнительных ключей Google.
-- См. docs/telephony-whisper.md и lib/telephony/whisperClips.ts.

ALTER TABLE "Settings" ADD COLUMN "geminiApiKeysExtra" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "WhisperClip" (
  "id" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "voice" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WhisperClip_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhisperClip_fileName_key" ON "WhisperClip"("fileName");
CREATE UNIQUE INDEX "WhisperClip_text_language_voice_key" ON "WhisperClip"("text", "language", "voice");
CREATE INDEX "WhisperClip_usedAt_idx" ON "WhisperClip"("usedAt");
