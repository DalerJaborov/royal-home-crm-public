-- Автофиксация времён Royal Score: момент первого открытия карточки клиента,
-- момент первой попытки контакта (первая запись Interaction) и момент первого
-- содержательного результата (первое закрытие обязательного окна "Итог
-- разговора"). См. Client.firstOpenedAt/firstContactAt/firstOutcomeAt в schema.prisma.
ALTER TABLE "Client" ADD COLUMN "firstOpenedAt" TIMESTAMP(3);
ALTER TABLE "Client" ADD COLUMN "firstContactAt" TIMESTAMP(3);
ALTER TABLE "Client" ADD COLUMN "firstOutcomeAt" TIMESTAMP(3);
