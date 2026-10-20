-- Журнал входящих звонков (решение владельца 08.08.2026). Маршрутизация звонков не
-- меняется: входящие по-прежнему идут только оператору, CRM их лишь записывает.
--
-- ВНИМАНИЕ. `prisma migrate diff` на этой базе дополнительно предлагает удалить
-- индексы Client_fullName_trgm_idx, Property_address_trgm_idx и Property_title_trgm_idx —
-- они созданы сырым SQL и в схеме не описаны. Эти DROP INDEX убраны намеренно:
-- выполнение такого diff молча ломает поиск по клиентам и объектам.

-- CreateTable
CREATE TABLE "IncomingCall" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "answered" BOOLEAN NOT NULL DEFAULT false,
    "talkSeconds" INTEGER,
    "answeredBy" TEXT,
    "clientId" TEXT,
    "interactionId" TEXT,
    "callbackAgentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncomingCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IncomingCall_channelId_key" ON "IncomingCall"("channelId");

-- CreateIndex
CREATE INDEX "IncomingCall_startedAt_idx" ON "IncomingCall"("startedAt");

-- CreateIndex
CREATE INDEX "IncomingCall_clientId_idx" ON "IncomingCall"("clientId");

-- CreateIndex
CREATE INDEX "IncomingCall_answered_startedAt_idx" ON "IncomingCall"("answered", "startedAt");

-- AddForeignKey
ALTER TABLE "IncomingCall" ADD CONSTRAINT "IncomingCall_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomingCall" ADD CONSTRAINT "IncomingCall_callbackAgentId_fkey" FOREIGN KEY ("callbackAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
