-- Подтверждение показа обеими сторонами (постановка владельца 31.07).
--
-- Три отметки вместо одного «статуса» намеренно: статус пришлось бы заводить
-- значением «не подтвердил», а такого состояния у клиента НЕТ. Молчание — это
-- отсутствие ответа, а не ответ, и отменять по нему показ нельзя.
ALTER TABLE "Interaction" ADD COLUMN "confirmAskedAt" TIMESTAMP(3);
ALTER TABLE "Interaction" ADD COLUMN "confirmedAt" TIMESTAMP(3);
ALTER TABLE "Interaction" ADD COLUMN "declinedAt" TIMESTAMP(3);
