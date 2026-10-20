-- «Раздать по группам Facebook» (28.09.2026, agent-briefs/facebook-groups-share-28-09.md).
-- Список групп живёт в Settings.facebookShareGroups (новая колонка), отметки
-- «выложено» — в новой таблице PropertyGroupShare, одна строка на пару
-- (объект, группа).

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "facebookShareGroups" TEXT[] NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "PropertyGroupShare" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "groupUrl" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "sharedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agentId" TEXT,

    CONSTRAINT "PropertyGroupShare_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PropertyGroupShare_propertyId_groupUrl_key" ON "PropertyGroupShare"("propertyId", "groupUrl");

ALTER TABLE "PropertyGroupShare" ADD CONSTRAINT "PropertyGroupShare_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PropertyGroupShare" ADD CONSTRAINT "PropertyGroupShare_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
