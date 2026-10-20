-- Находки разбора 09.08.2026 (docs/audit-09-08-2026.md).

-- 1. Уникальность события Royal Score — в пределах АГЕНТА, а не по всей базе.
-- Пока ключ был (kind, sourceId), «один штраф на карточку» означало один штраф на
-- карточку на всю компанию: клиенту, перешедшему ко второму агенту, защита от
-- повтора доставалась вместе с ним, и предупреждения/штрафы второму и последующим
-- молча не записывались.
DROP INDEX IF EXISTS "RoyalScoreEvent_kind_sourceId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "RoyalScoreEvent_kind_sourceId_agentId_key"
  ON "RoyalScoreEvent" ("kind", "sourceId", "agentId");

-- 2. Индексы, которых не было под уже существующие запросы.
-- Таблицу фотографий тянет каждый список объектов, карточка и синхронизация с
-- сайтом — индекса не было ни одного, в отличие от соседних PropertyVideo и PriceChange.
CREATE INDEX IF NOT EXISTS "PropertyPhoto_propertyId_idx" ON "PropertyPhoto" ("propertyId");

-- Ночной автостатус клиентов: отбор по kind + сортировка по давности контакта.
CREATE INDEX IF NOT EXISTS "Client_kind_lastContactAt_idx" ON "Client" ("kind", "lastContactAt");

-- «История объекта»/«история клиента» на карточке: отбор журнала по одному entityId.
CREATE INDEX IF NOT EXISTS "AuditLog_entityId_createdAt_idx" ON "AuditLog" ("entityId", "createdAt");

-- Инбокс сортирует переписки по последнему сообщению, кроны по нему же отбирают.
CREATE INDEX IF NOT EXISTS "BotConversation_lastMessageAt_idx" ON "BotConversation" ("lastMessageAt");
CREATE INDEX IF NOT EXISTS "TelegramConversation_lastMessageAt_idx" ON "TelegramConversation" ("lastMessageAt");
