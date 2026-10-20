-- Журнал показов: какой объект бот реально отправил конкретному человеку.
--
-- Не заменяет ShownProperty: тот — недельный предохранитель от повторной отправки
-- тех же фотографий, он сам себя стирает и с карточкой клиента не связан. Этот —
-- история, на которой держится решение владельца 11.08.2026: клиент, которому бот
-- показал объект, уходит хозяину этого объекта безусловно.
--
-- Уникальности нет нарочно — журнал событий, а не состояние. Показали дважды —
-- две строки, так и было.
--
-- ВНИМАНИЕ: `prisma migrate diff` дополнительно предложил DROP INDEX для трёх
-- триграммных индексов поиска (Client_fullName_trgm_idx, Property_address_trgm_idx,
-- Property_title_trgm_idx). Они заведены сырой миграцией, в datamodel Prisma их нет
-- по определению, и удалять их нельзя — на них держится поиск.

-- CreateTable
CREATE TABLE "PropertyExposure" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "clientId" TEXT,
    "propertyId" TEXT,
    "shortId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropertyExposure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PropertyExposure_clientId_propertyId_idx" ON "PropertyExposure"("clientId", "propertyId");

-- CreateIndex
CREATE INDEX "PropertyExposure_channel_recipientId_sentAt_idx" ON "PropertyExposure"("channel", "recipientId", "sentAt");

-- CreateIndex
CREATE INDEX "PropertyExposure_sentAt_idx" ON "PropertyExposure"("sentAt");

-- AddForeignKey
ALTER TABLE "PropertyExposure" ADD CONSTRAINT "PropertyExposure_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyExposure" ADD CONSTRAINT "PropertyExposure_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;
