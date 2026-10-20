-- Одна попытка автоприёма на диалог (авария 17.09.2026: сторож лидов гонял приём
-- по одному и тому же разговору о работе каждые 15 минут — карточки там не бывает
-- по определению, и петля кормила сама себя).
ALTER TABLE "BotConversation" ADD COLUMN "watchdogAttemptedAt" TIMESTAMP(3);

-- Частичный индекс под выборку сторожа: он берёт только ещё не пробованные.
CREATE INDEX "BotConversation_watchdogAttemptedAt_idx"
  ON "BotConversation" ("lastMessageAt")
  WHERE "clientId" IS NULL AND "watchdogAttemptedAt" IS NULL;
