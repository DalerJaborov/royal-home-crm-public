-- Потолок минут робота (П5, 11.11.2026). Аддитивно: два поля Settings с умолчаниями и
-- индекс на LiveVoiceSession. Существующие строки не меняются, ничего не удаляется.
-- Таблица LiveVoiceSession маленькая (одна линия робота — сотни строк в месяц), поэтому
-- индекс строится обычным CREATE INDEX внутри транзакции миграции.

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "liveVoiceDailyMinutesCap" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN "liveVoiceMonthlyMinutesCap" INTEGER NOT NULL DEFAULT 250;

-- CreateIndex
CREATE INDEX "LiveVoiceSession_provider_startedAt_idx" ON "LiveVoiceSession"("provider", "startedAt");
