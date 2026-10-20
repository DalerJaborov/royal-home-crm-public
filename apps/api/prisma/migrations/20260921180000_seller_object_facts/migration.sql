-- ФАКТЫ ОБ ОБЪЕКТЕ ПРОДАВЦА + СОТКИ У ОБЪЕКТА (владелец 21.09.2026).
--
-- Правка ТОЛЬКО ДОБАВЛЯЕТ: новая таблица 1:1 с Client и одна необязательная
-- колонка у Property. Существующие строки не меняются; у старых объектов сотки
-- пустые, у продавцов строка фактов появится на первом разборе.

-- AlterTable
ALTER TABLE "Property" ADD COLUMN "landAreaSotka" DECIMAL(65,30);

-- CreateTable
CREATE TABLE "SellerObjectFacts" (
    "clientId" TEXT NOT NULL,
    "facts" JSONB,
    "factsInputHash" TEXT,
    "factsSourceUpTo" TIMESTAMP(3),
    "factsCallIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "factsUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SellerObjectFacts_pkey" PRIMARY KEY ("clientId")
);

-- AddForeignKey
ALTER TABLE "SellerObjectFacts" ADD CONSTRAINT "SellerObjectFacts_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
