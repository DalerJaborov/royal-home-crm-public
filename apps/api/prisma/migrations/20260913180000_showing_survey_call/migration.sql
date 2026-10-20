-- Опрос-звонок после показа (антифрод, 13.09.2026) — см. docs/TASKS.md и
-- docs/post-viewing-survey-design-11-09.md. Выключено по умолчанию.
-- Написано руками (см. 20260912100200_bot_pause_watch) — БД недоступна в среде агента.

ALTER TABLE "Settings" ADD COLUMN "showingSurveyEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ShowingSurveyCall" (
    "id" TEXT NOT NULL,
    "interactionId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "propertyId" TEXT,
    "channelId" TEXT,
    "calledAt" TIMESTAMP(3),
    "transcript" TEXT,
    "recordingUrl" TEXT,
    "redFlags" JSONB,
    "escalatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShowingSurveyCall_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShowingSurveyCall_interactionId_key" ON "ShowingSurveyCall"("interactionId");
CREATE INDEX "ShowingSurveyCall_agentId_idx" ON "ShowingSurveyCall"("agentId");
CREATE INDEX "ShowingSurveyCall_clientId_idx" ON "ShowingSurveyCall"("clientId");
