-- Ник клиента в соцсети: отдельным полем, а не в fullName и не в названии диалога.
-- AlterTable
ALTER TABLE "Client" ADD COLUMN "socialUsername" TEXT;
ALTER TABLE "Client" ADD COLUMN "socialChannel" TEXT;

-- Отбор кандидатов: «учится сейчас где угодно» и «работает сейчас».
-- studyingUniversity НЕ трогаем: по нему уже принято eligible у старых анкет.
-- AlterTable
ALTER TABLE "JobApplication" ADD COLUMN "studyingNow" BOOLEAN;
ALTER TABLE "JobApplication" ADD COLUMN "employedNow" BOOLEAN;

-- Заявка агента на удаление карточки клиента: агент просит, решает руководство.
-- CreateTable
CREATE TABLE "ClientDeleteRequest" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientDeleteRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientDeleteRequest_status_createdAt_idx" ON "ClientDeleteRequest"("status", "createdAt");
CREATE INDEX "ClientDeleteRequest_clientId_status_idx" ON "ClientDeleteRequest"("clientId", "status");

-- AddForeignKey
ALTER TABLE "ClientDeleteRequest" ADD CONSTRAINT "ClientDeleteRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientDeleteRequest" ADD CONSTRAINT "ClientDeleteRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClientDeleteRequest" ADD CONSTRAINT "ClientDeleteRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
