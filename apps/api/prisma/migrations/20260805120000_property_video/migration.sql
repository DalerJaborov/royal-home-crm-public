-- CreateTable
CREATE TABLE "PropertyVideo" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedById" TEXT NOT NULL,

    CONSTRAINT "PropertyVideo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PropertyVideo_propertyId_idx" ON "PropertyVideo"("propertyId");

-- AddForeignKey
ALTER TABLE "PropertyVideo" ADD CONSTRAINT "PropertyVideo_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyVideo" ADD CONSTRAINT "PropertyVideo_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: дедлайн монтажа 72ч=3дня (владелец 05.08.2026), лимиты сырого видео
ALTER TABLE "Settings" ALTER COLUMN "propertyEditingDays" SET DEFAULT 3;
ALTER TABLE "Settings" ADD COLUMN     "propertyVideoMaxCount" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "propertyVideoMaxSizeMb" INTEGER NOT NULL DEFAULT 600;

-- Существующая запись Settings ещё не тронута владельцем (стоит старый дефолт 2) —
-- поднимаем до нового дефолта 3. Если директор уже менял это поле вручную, значение
-- будет отличаться от 2, и апдейт его не заденет.
UPDATE "Settings" SET "propertyEditingDays" = 3 WHERE "id" = 'singleton' AND "propertyEditingDays" = 2;
