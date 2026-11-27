-- Рубильники «клиент по объекту — хозяину объекта» во всех каналах (27.11.2026, владелец: «чтобы агенты не теряли своих клиентов»).
-- Только добавляют колонки; переключает человек в Настройках.
ALTER TABLE "Settings" ADD COLUMN "chatObjectToOwnerEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "callAdObjectToOwnerEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "objectInterestPullsQueueLeadEnabled" BOOLEAN NOT NULL DEFAULT true;
-- Пуш хозяину объекта о клиенте другого агента — ВЫКЛ (владелец 27.11: «пусть ничего не получает сам агент потом скажет»).
ALTER TABLE "Settings" ADD COLUMN "notifyOwnerOfOtherAgentClientEnabled" BOOLEAN NOT NULL DEFAULT false;
-- Пуши хозяину объекта по переписке без карточки/заявки клиента — ВЫКЛ (владелец 27.11: «просто интересуется… отключи это уведомление»).
ALTER TABLE "Settings" ADD COLUMN "notifyOwnerBeforeLeadEnabled" BOOLEAN NOT NULL DEFAULT false;
