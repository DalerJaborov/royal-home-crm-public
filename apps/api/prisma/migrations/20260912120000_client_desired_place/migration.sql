-- 12.09.2026, docs/geo-match-plan-12-09.md: фундамент под гео-подбор объектов —
-- несколько желаемых мест поиска покупателя (координата + радиус), а не поля
-- на Client. Причина владельца: покупатель в разговоре часто называет два-три
-- места сразу («ищу у ЦУМа или в 82-м микрорайоне»), одна точка это не покрывает.
-- Сам подбор (lib/propertyMatchFilter.ts, routes/matching.ts) эта миграция не трогает.

-- CreateTable
CREATE TABLE "ClientDesiredPlace" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "lat" DECIMAL(65,30) NOT NULL,
  "lng" DECIMAL(65,30) NOT NULL,
  "radiusM" INTEGER NOT NULL DEFAULT 1000,
  "label" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ClientDesiredPlace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientDesiredPlace_clientId_idx" ON "ClientDesiredPlace"("clientId");

-- CreateIndex: предфильтр по прямоугольнику для будущего гео-подбора.
CREATE INDEX "ClientDesiredPlace_lat_lng_idx" ON "ClientDesiredPlace"("lat", "lng");

-- AddForeignKey
ALTER TABLE "ClientDesiredPlace" ADD CONSTRAINT "ClientDesiredPlace_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
