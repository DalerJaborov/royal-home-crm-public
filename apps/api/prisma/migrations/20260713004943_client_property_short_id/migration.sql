-- AlterTable: короткий числовой ID для читаемых URL — SERIAL сам присваивает
-- существующим строкам последовательные значения при добавлении колонки.
ALTER TABLE "Client" ADD COLUMN "shortId" SERIAL;
ALTER TABLE "Property" ADD COLUMN "shortId" SERIAL;

-- CreateIndex
CREATE UNIQUE INDEX "Client_shortId_key" ON "Client"("shortId");
CREATE UNIQUE INDEX "Property_shortId_key" ON "Property"("shortId");
