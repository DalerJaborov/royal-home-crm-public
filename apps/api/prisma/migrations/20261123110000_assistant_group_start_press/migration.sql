-- Кто нажал /start или написал «меню» в ещё не подключённой группе Шабнам (23.11.2026).
-- Только добавление новой таблицы; строки живут не дольше 48 часов (чистит сам код при записи).
CREATE TABLE "AssistantGroupStartPress" (
    "chatId" TEXT NOT NULL,
    "telegramUserId" TEXT NOT NULL,
    "telegramName" TEXT NOT NULL DEFAULT '',
    "pressedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantGroupStartPress_pkey" PRIMARY KEY ("chatId","telegramUserId")
);

CREATE INDEX "AssistantGroupStartPress_pressedAt_idx" ON "AssistantGroupStartPress"("pressedAt");
