-- Новый исход звонка продавцу — запускает таймер «Итог объекта».
ALTER TYPE "InteractionOutcome" ADD VALUE 'PROPERTY_ACCEPTED';

-- Client: момент исхода звонка «Объект принят в работу» — таймер «Итог объекта»
-- считается от него, а не от создания карточки Property.
ALTER TABLE "Client" ADD COLUMN "propertyAcceptedAt" TIMESTAMP(3);

-- Property: заявка продавца, из которой создан этот объект (строкой, без FK —
-- как subjectId в PendingSummary), чтобы перенести таймер с клиента на карточку.
ALTER TABLE "Property" ADD COLUMN "sellerClientId" TEXT;
