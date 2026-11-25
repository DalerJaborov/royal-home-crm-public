-- Сервер сжимает фото и видео сотрудника под канал клиента и шлёт в фоне (25.11.2026). Рубильник ВКЛ.
ALTER TABLE "Settings" ADD COLUMN "outgoingMediaCompressEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "OutgoingMediaJob" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "inputName" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "caption" TEXT,
    "note" TEXT,
    "error" TEXT,
    "outBytes" INTEGER,
    "outMime" TEXT,
    "prepareMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "OutgoingMediaJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OutgoingMediaJob_conversationId_createdAt_idx" ON "OutgoingMediaJob"("conversationId", "createdAt");
CREATE INDEX "OutgoingMediaJob_status_updatedAt_idx" ON "OutgoingMediaJob"("status", "updatedAt");
