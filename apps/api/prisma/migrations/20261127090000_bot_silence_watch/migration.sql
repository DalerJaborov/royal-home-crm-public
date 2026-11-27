-- Сторож «бот замолчал» (27.11.2026, инцидент 26.11: бот не отвечал клиентам с 16:00 до 20:22 по Душанбе).
-- Только добавляет: рубильник ВКЛ по умолчанию и таблицу эпизодов. Существующие данные не меняются.
ALTER TABLE "Settings" ADD COLUMN "botSilenceWatchEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "BotSilenceIncident" (
    "id" TEXT NOT NULL,
    "channels" TEXT[],
    "startedAt" TIMESTAMP(3) NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAlertAt" TIMESTAMP(3) NOT NULL,
    "missedKeys" JSONB NOT NULL DEFAULT '[]',
    "recoveredAt" TIMESTAMP(3),

    CONSTRAINT "BotSilenceIncident_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BotSilenceIncident_recoveredAt_idx" ON "BotSilenceIncident"("recoveredAt");

-- Один открытый эпизод на всю систему: сторож в другом процессе не заведёт параллельный (вторая тревога о том же).
CREATE UNIQUE INDEX "BotSilenceIncident_one_open_key" ON "BotSilenceIncident" ((true)) WHERE "recoveredAt" IS NULL;
