-- Автоматизация жизненного цикла клиента: молчаливый → Неактивные (5 дней),
-- Потерянные/Неактивные → Корзина (3 месяца, настраиваемо).
-- AlterTable
ALTER TABLE "Client" ADD COLUMN "lostAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "silentClientInactiveDays" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "Settings" ADD COLUMN "lostOrInactiveToTrashAfterDays" INTEGER NOT NULL DEFAULT 90;
