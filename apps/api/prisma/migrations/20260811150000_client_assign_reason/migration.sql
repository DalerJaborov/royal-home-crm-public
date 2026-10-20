-- Почему лид достался именно этому агенту и из-за какого объекта.
--
-- Нужно для объяснимости: с 11.08.2026 лид может уйти мимо очереди по KPI —
-- хозяину подходящего объекта. Без записанной причины это выглядит как сбой
-- распределения и для агента, и для владельца, а спорить с CRM, которая не
-- объясняет своих решений, нельзя.
--
-- matchedPropertyId с SetNull: объект могли продать или удалить, но причина
-- назначения от этого не изменилась — рядом остаётся запись SYSTEM в хронологии
-- клиента с номером объекта.

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "assignReason" TEXT,
ADD COLUMN     "matchedPropertyId" TEXT;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_matchedPropertyId_fkey" FOREIGN KEY ("matchedPropertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;
