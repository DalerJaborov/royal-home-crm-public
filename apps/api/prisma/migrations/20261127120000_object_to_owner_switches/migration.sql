-- Рубильники «клиент по объекту — хозяину объекта» во всех каналах (27.11.2026, владелец: «чтобы агенты не теряли своих клиентов»).
-- Только добавляют колонки; переключает человек в Настройках.
ALTER TABLE "Settings" ADD COLUMN "chatObjectToOwnerEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "callAdObjectToOwnerEnabled" BOOLEAN NOT NULL DEFAULT true;
-- Перенос непринятой заявки к хозяину объекта — ВЫКЛ (решение владельца 27.11: «Оставить + показ хозяину»).
ALTER TABLE "Settings" ADD COLUMN "objectInterestPullsQueueLeadEnabled" BOOLEAN NOT NULL DEFAULT false;
