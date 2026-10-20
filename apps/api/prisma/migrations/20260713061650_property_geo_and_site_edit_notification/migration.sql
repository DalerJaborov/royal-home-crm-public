-- AlterTable: точные координаты объекта (геокодирование по адресу)
ALTER TABLE "Property" ADD COLUMN "lat" DECIMAL(65,30);
ALTER TABLE "Property" ADD COLUMN "lng" DECIMAL(65,30);
ALTER TABLE "Property" ADD COLUMN "geocodedAt" TIMESTAMP(3);

-- CreateTable: уведомления о правках объекта на сайте (обратная связь сайт -> CRM)
CREATE TABLE "SiteEditNotification" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "changes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,

    CONSTRAINT "SiteEditNotification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SiteEditNotification_propertyId_resolvedAt_idx" ON "SiteEditNotification"("propertyId", "resolvedAt");

ALTER TABLE "SiteEditNotification" ADD CONSTRAINT "SiteEditNotification_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
