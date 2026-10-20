-- Журнал ключей от квартир: кто из агентов какой ключ взял на показ и вернул ли.
-- До этого журнал вёлся на словах, и найти ключ можно было только обзвоном.

CREATE TABLE "KeyHandover" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "issuedById" TEXT,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returnedAt" TIMESTAMP(3),
    "returnedById" TEXT,
    "note" TEXT,
    "alertSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeyHandover_pkey" PRIMARY KEY ("id")
);

-- Главный запрос экрана и джоба напоминаний — «что сейчас на руках»:
-- невозвращённые (returnedAt IS NULL), самые давние сверху.
CREATE INDEX "KeyHandover_returnedAt_takenAt_idx" ON "KeyHandover"("returnedAt", "takenAt");
CREATE INDEX "KeyHandover_propertyId_idx" ON "KeyHandover"("propertyId");
CREATE INDEX "KeyHandover_agentId_idx" ON "KeyHandover"("agentId");

-- Удаление объекта уносит его журнал ключей: без объекта запись бессмысленна.
-- Агента, за которым числится ключ, удалить нельзя — сначала нужно закрыть выдачу.
ALTER TABLE "KeyHandover" ADD CONSTRAINT "KeyHandover_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KeyHandover" ADD CONSTRAINT "KeyHandover_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "KeyHandover" ADD CONSTRAINT "KeyHandover_issuedById_fkey"
  FOREIGN KEY ("issuedById") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Через сколько часов невозврата предупреждать руководство. Владелец называл и 4, и 12,
-- поэтому значение настраивается, а не зашито в коде.
ALTER TABLE "Settings" ADD COLUMN "keyReturnAlertHours" INTEGER NOT NULL DEFAULT 4;
