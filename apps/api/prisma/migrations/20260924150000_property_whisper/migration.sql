-- Подсказка агенту по приметам объекта (перевод звонка агенту объекта, 24.09.2026).
CREATE TABLE "PropertyWhisper" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyWhisper_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PropertyWhisper_fileName_key" ON "PropertyWhisper"("fileName");
CREATE UNIQUE INDEX "PropertyWhisper_propertyId_language_key" ON "PropertyWhisper"("propertyId", "language");

ALTER TABLE "PropertyWhisper" ADD CONSTRAINT "PropertyWhisper_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
