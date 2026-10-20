-- Простой телефонии: окна, когда CRM не могла достучаться до станции.
-- Нужны счётчику тишины, чтобы день без АТС не превратился в тревогу по всем
-- агентам разом (дыра 4.2, docs/karta-resheniy-i-dyr-09-09-2026.md).
CREATE TABLE "StationOutage" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StationOutage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StationOutage_startedAt_idx" ON "StationOutage"("startedAt");
CREATE INDEX "StationOutage_endedAt_idx" ON "StationOutage"("endedAt");
