-- Реестр разрешённых строек Душанбе (memor.pro, 20.11.2026, решение владельца). Только добавление: 5 новых таблиц, 3 enum и две колонки Settings
-- (рубильники по умолчанию ВКЛ: сама по себе таблица пуста до первого забора). Данные только для сотрудников. Читает lib/constructionRegistry/.
-- CreateEnum
CREATE TYPE "ConstructionColor" AS ENUM ('GREEN', 'YELLOW', 'RED');

-- CreateEnum
CREATE TYPE "ConstructionLinkState" AS ENUM ('LINKED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ConstructionLinkMethod" AS ENUM ('AUTO', 'MANUAL');

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "constructionRegistryEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "constructionRegistryNotify" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ConstructionDeveloper" (
    "id" TEXT NOT NULL,
    "nameNormalized" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConstructionDeveloper_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConstructionProject" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "qaror" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "customer" TEXT NOT NULL,
    "developerId" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "category" TEXT NOT NULL,
    "eduType" TEXT,
    "colorStatus" "ConstructionColor" NOT NULL,
    "isComplete" BOOLEAN NOT NULL DEFAULT false,
    "hasCommission" BOOLEAN NOT NULL DEFAULT false,
    "sourceUrl" TEXT NOT NULL,
    "listHash" TEXT NOT NULL,
    "address" TEXT,
    "description" TEXT,
    "floors" INTEGER,
    "blocks" TEXT[],
    "documents" JSONB NOT NULL DEFAULT '[]',
    "warning" TEXT,
    "detailFetchedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusChangedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "ConstructionProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConstructionStatusChange" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "fromColor" "ConstructionColor",
    "toColor" "ConstructionColor" NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),

    CONSTRAINT "ConstructionStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConstructionPropertyLink" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "state" "ConstructionLinkState" NOT NULL,
    "method" "ConstructionLinkMethod" NOT NULL,
    "confidence" INTEGER NOT NULL DEFAULT 0,
    "distanceM" INTEGER,
    "reasons" TEXT[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConstructionPropertyLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConstructionSyncRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "trigger" TEXT NOT NULL,
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "changed" INTEGER NOT NULL DEFAULT 0,
    "removed" INTEGER NOT NULL DEFAULT 0,
    "detailsFetched" INTEGER NOT NULL DEFAULT 0,
    "linked" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "ConstructionSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConstructionDeveloper_nameNormalized_key" ON "ConstructionDeveloper"("nameNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "ConstructionProject_sourceId_key" ON "ConstructionProject"("sourceId");

-- CreateIndex
CREATE INDEX "ConstructionProject_developerId_idx" ON "ConstructionProject"("developerId");

-- CreateIndex
CREATE INDEX "ConstructionProject_colorStatus_category_idx" ON "ConstructionProject"("colorStatus", "category");

-- CreateIndex
CREATE INDEX "ConstructionProject_removedAt_idx" ON "ConstructionProject"("removedAt");

-- CreateIndex
CREATE INDEX "ConstructionStatusChange_projectId_changedAt_idx" ON "ConstructionStatusChange"("projectId", "changedAt");

-- CreateIndex
CREATE INDEX "ConstructionPropertyLink_propertyId_state_idx" ON "ConstructionPropertyLink"("propertyId", "state");

-- CreateIndex
CREATE INDEX "ConstructionPropertyLink_projectId_idx" ON "ConstructionPropertyLink"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ConstructionPropertyLink_propertyId_projectId_key" ON "ConstructionPropertyLink"("propertyId", "projectId");

-- CreateIndex
CREATE INDEX "ConstructionSyncRun_startedAt_idx" ON "ConstructionSyncRun"("startedAt");

-- AddForeignKey
ALTER TABLE "ConstructionProject" ADD CONSTRAINT "ConstructionProject_developerId_fkey" FOREIGN KEY ("developerId") REFERENCES "ConstructionDeveloper"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConstructionStatusChange" ADD CONSTRAINT "ConstructionStatusChange_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ConstructionProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConstructionPropertyLink" ADD CONSTRAINT "ConstructionPropertyLink_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConstructionPropertyLink" ADD CONSTRAINT "ConstructionPropertyLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ConstructionProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

