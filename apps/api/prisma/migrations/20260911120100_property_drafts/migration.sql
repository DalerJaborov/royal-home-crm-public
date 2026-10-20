-- ЧЕРНОВИК НОВОГО ОБЪЕКТА (11.09.2026): поля мастера и уже отданные файлы живут
-- на сервере, а не в localStorage браузера — иначе черновик не переживает смену
-- устройства и не может держать снимки.

CREATE TYPE "PropertyDraftMediaKind" AS ENUM ('PHOTO', 'VIDEO');
CREATE TYPE "PropertyDraftMediaStatus" AS ENUM ('UPLOADING', 'READY');

CREATE TABLE "PropertyDraft" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "values" JSONB NOT NULL DEFAULT '{}',
    "step" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyDraft_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PropertyDraft_agentId_key" ON "PropertyDraft"("agentId");
CREATE INDEX "PropertyDraft_expiresAt_idx" ON "PropertyDraft"("expiresAt");

CREATE TABLE "PropertyDraftMedia" (
    "id" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "kind" "PropertyDraftMediaKind" NOT NULL,
    "status" "PropertyDraftMediaStatus" NOT NULL DEFAULT 'UPLOADING',
    "uploadKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "url" TEXT,
    "thumbUrl" TEXT,
    "storageKey" TEXT,
    "partSize" INTEGER,
    "totalParts" INTEGER,
    "parts" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyDraftMedia_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PropertyDraftMedia_uploadKey_key" ON "PropertyDraftMedia"("uploadKey");
CREATE INDEX "PropertyDraftMedia_draftId_idx" ON "PropertyDraftMedia"("draftId");

ALTER TABLE "PropertyDraft" ADD CONSTRAINT "PropertyDraft_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PropertyDraftMedia" ADD CONSTRAINT "PropertyDraftMedia_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "PropertyDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
