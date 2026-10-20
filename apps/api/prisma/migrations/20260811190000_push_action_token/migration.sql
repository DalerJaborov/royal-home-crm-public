-- Право на ОДНО действие из шторки уведомлений (кнопки «Принять»/«Отклонить»).
-- Из вывода `prisma migrate diff` вручную убраны три `DROP INDEX` по триграммным
-- индексам поиска (Client_fullName_trgm_idx, Property_title_trgm_idx,
-- Property_address_trgm_idx): они заведены сырой миграцией и в datamodel их нет
-- по определению, а их удаление молча убивает поиск.

-- CreateTable
CREATE TABLE "PushActionToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushActionToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PushActionToken_tokenHash_key" ON "PushActionToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PushActionToken_agentId_idx" ON "PushActionToken"("agentId");

-- CreateIndex
CREATE INDEX "PushActionToken_expiresAt_idx" ON "PushActionToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "PushActionToken" ADD CONSTRAINT "PushActionToken_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
