-- Рубильники «клиент по объекту — хозяину объекта» во всех каналах (27.11.2026, владелец: «чтобы агенты не теряли своих клиентов»).
-- Только добавляют колонки, ВКЛ по умолчанию; выключает человек в Настройках.
ALTER TABLE "Settings" ADD COLUMN "chatObjectToOwnerEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "callAdObjectToOwnerEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "objectInterestPullsQueueLeadEnabled" BOOLEAN NOT NULL DEFAULT true;
