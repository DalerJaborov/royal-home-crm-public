-- Атрибуция рекламы и журнал переходов (26.08.2026, архитектурное ревью, пункт 4).
-- Чисто аддитивно: две колонки и новая таблица, поведение не меняется — данные
-- начинают копиться, отчёты (ROMI по объявлению, застревание сделок) строятся потом.

-- С какого объявления Meta пришёл диалог (referral.ad_id из первого сообщения).
ALTER TABLE "BotConversation" ADD COLUMN IF NOT EXISTS "adExternalId" TEXT;

-- Какое объявление привело клиента — переносится при привязке диалога к карточке.
ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "sourceAdId" TEXT;

-- Журнал переходов Client.status/workStatus и Deal.stage. Без внешних ключей
-- нарочно: история обязана переживать удаление клиента, сделки и сотрудника.
CREATE TABLE IF NOT EXISTS "StageEvent" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "from" TEXT,
    "to" TEXT NOT NULL,
    "agentId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StageEvent_pkey" PRIMARY KEY ("id")
);

-- Путь одной сущности по времени — главный запрос будущих отчётов.
CREATE INDEX IF NOT EXISTS "StageEvent_entityType_entityId_at_idx"
    ON "StageEvent"("entityType", "entityId", "at");
