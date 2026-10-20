-- Подсказка агенту перед соединением (Settings + Agent.whisperLanguage + CallWhisper).
-- См. docs/telephony-whisper.md.

ALTER TABLE "Settings"
  ADD COLUMN "callWhisperEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "callWhisperIncoming" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "callWhisperOutgoing" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "callWhisperIncomingParts" TEXT[] NOT NULL DEFAULT ARRAY['name', 'role', 'anchor', 'recency']::TEXT[],
  ADD COLUMN "callWhisperOutgoingParts" TEXT[] NOT NULL DEFAULT ARRAY['name', 'role']::TEXT[],
  ADD COLUMN "callWhisperLanguage" TEXT NOT NULL DEFAULT 'tg',
  ADD COLUMN "callWhisperVoice" TEXT NOT NULL DEFAULT 'Kore',
  ADD COLUMN "callWhisperAiHint" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "callWhisperStationToken" TEXT,
  ADD COLUMN "callWhisperFetchedAt" TIMESTAMP(3);

ALTER TABLE "Agent" ADD COLUMN "whisperLanguage" TEXT;

CREATE TABLE "CallWhisper" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "digest" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CallWhisper_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CallWhisper_fileName_key" ON "CallWhisper"("fileName");
CREATE UNIQUE INDEX "CallWhisper_clientId_direction_language_key" ON "CallWhisper"("clientId", "direction", "language");
CREATE INDEX "CallWhisper_updatedAt_idx" ON "CallWhisper"("updatedAt");

ALTER TABLE "CallWhisper"
  ADD CONSTRAINT "CallWhisper_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
