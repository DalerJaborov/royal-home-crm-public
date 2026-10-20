-- Суточный бюджет ходов ИИ там, где своей колонки нет: Telegram и комментарии
-- под публикациями (аудит 22.08.2026). До этого предел из решения владельца от
-- 21.08.2026 действовал только в переписке Meta — в остальных двух каналах ходы
-- модели никто не считал.
--
-- Аддитивно: только новая таблица, ни одна существующая не трогается.
-- Колонки названы так же, как одноимённые у "BotConversation": расчёт остатка
-- (lib/aiDailyBudget.ts) один на оба хранилища и различает их только именем таблицы.

-- CreateTable
CREATE TABLE "AiBudgetCounter" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "peerId" TEXT NOT NULL,
    "aiBudgetDate" TEXT,
    "aiTurnsToday" INTEGER NOT NULL DEFAULT 0,
    "aiVoiceToday" INTEGER NOT NULL DEFAULT 0,
    "aiPhotoToday" INTEGER NOT NULL DEFAULT 0,
    "aiVideoToday" INTEGER NOT NULL DEFAULT 0,
    "aiDocToday" INTEGER NOT NULL DEFAULT 0,
    "aiLimitNoticeAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiBudgetCounter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Ключ счёта и одновременно защита от гонки: два сообщения одного человека
-- обрабатываются параллельно, и вторая вставка обязана попасть в ON CONFLICT,
-- а не завести вторую строку с собственным бюджетом.
CREATE UNIQUE INDEX "AiBudgetCounter_channel_peerId_key" ON "AiBudgetCounter"("channel", "peerId");
