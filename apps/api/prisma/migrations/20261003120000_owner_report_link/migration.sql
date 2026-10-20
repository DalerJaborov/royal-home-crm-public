-- «Отчёт владельцу объекта» (03.10.2026) — только добавление: одна новая таблица.
-- Ни одна существующая таблица и колонка не меняется.

CREATE TABLE "PropertyOwnerReportLink" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastViewedAt" TIMESTAMP(3),
    "viewsCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PropertyOwnerReportLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PropertyOwnerReportLink_token_key" ON "PropertyOwnerReportLink"("token");
CREATE INDEX "PropertyOwnerReportLink_propertyId_idx" ON "PropertyOwnerReportLink"("propertyId");

-- Одна ДЕЙСТВУЮЩАЯ ссылка на объект: два одновременных «создать» не выпустят две.
-- Частичный индекс — Prisma такие не выражает, он живёт только здесь и в `migrate diff`
-- расхождения не даёт (как Interaction_transcriptionStage_partial_idx).
CREATE UNIQUE INDEX "PropertyOwnerReportLink_propertyId_active_key"
    ON "PropertyOwnerReportLink"("propertyId") WHERE "revokedAt" IS NULL;

ALTER TABLE "PropertyOwnerReportLink" ADD CONSTRAINT "PropertyOwnerReportLink_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PropertyOwnerReportLink" ADD CONSTRAINT "PropertyOwnerReportLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
