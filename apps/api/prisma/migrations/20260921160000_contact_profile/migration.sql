-- ДОСЬЕ СОБЕСЕДНИКА: карточка на каждого написавшего (владелец 21.09.2026).
--
-- Зачем: бот «не помнит» человека. Всё, что он знал, лежало в черновике ОДНОГО
-- диалога (BotConversation.leadDraft) и в переписке, обрезанной до 40 реплик.
-- Тот же человек из другого канала — новый незнакомец; вернулся через неделю —
-- имя и номер спрашиваются заново. Карточка Client не спасает: она заводится
-- только когда лид оформлен, то есть ПОСЛЕ телефона и готовности.
--
-- Правка ТОЛЬКО ДОБАВЛЯЕТ: четыре новые таблицы и по одной необязательной
-- колонке-ссылке в четырёх таблицах диалогов. Ни одна существующая строка не
-- меняется, ни одна колонка не удаляется — старые диалоги живут с пустой
-- ссылкой, и код обязан это переносить (досье заводится на следующем входящем).
--
-- Уникальный индекс ContactIdentity(kind, value) — главная защита от двойников:
-- при одновременных входящих вторая вставка падает на индексе, а не заводит
-- второе досье молча. Тот же приём, что Client.phone UNIQUE.
--
-- Разбор: docs/contact-profile-and-bot-roles-20-09.md

-- AlterTable
ALTER TABLE "BotConversation" ADD COLUMN     "contactProfileId" TEXT;

-- AlterTable
ALTER TABLE "IncomingCall" ADD COLUMN     "contactProfileId" TEXT;

-- AlterTable
ALTER TABLE "TelegramConversation" ADD COLUMN     "contactProfileId" TEXT;

-- AlterTable
ALTER TABLE "TelegramDirectConversation" ADD COLUMN     "contactProfileId" TEXT;

-- CreateTable
CREATE TABLE "ContactProfile" (
    "id" TEXT NOT NULL,
    "displayName" TEXT,
    "nameSource" TEXT,
    "category" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "categorySetAt" TIMESTAMP(3),
    "categoryHistory" JSONB NOT NULL DEFAULT '[]',
    "language" TEXT,
    "languageCounts" JSONB NOT NULL DEFAULT '{}',
    "facts" JSONB NOT NULL DEFAULT '{}',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "messagesIn" INTEGER NOT NULL DEFAULT 0,
    "clientId" TEXT,
    "mergedIntoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactIdentity" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "trust" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactLinkCandidate" (
    "id" TEXT NOT NULL,
    "leftId" TEXT NOT NULL,
    "rightId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,

    CONSTRAINT "ContactLinkCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactProfileMerge" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "mergedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mergedById" TEXT,

    CONSTRAINT "ContactProfileMerge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContactProfile_lastSeenAt_idx" ON "ContactProfile"("lastSeenAt");

-- CreateIndex
CREATE INDEX "ContactProfile_clientId_idx" ON "ContactProfile"("clientId");

-- CreateIndex
CREATE INDEX "ContactProfile_category_idx" ON "ContactProfile"("category");

-- CreateIndex
CREATE INDEX "ContactProfile_mergedIntoId_idx" ON "ContactProfile"("mergedIntoId");

-- CreateIndex
CREATE INDEX "ContactIdentity_profileId_idx" ON "ContactIdentity"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactIdentity_kind_value_key" ON "ContactIdentity"("kind", "value");

-- CreateIndex
CREATE INDEX "ContactLinkCandidate_status_idx" ON "ContactLinkCandidate"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ContactLinkCandidate_leftId_rightId_key" ON "ContactLinkCandidate"("leftId", "rightId");

-- CreateIndex
CREATE INDEX "ContactProfileMerge_targetId_idx" ON "ContactProfileMerge"("targetId");

-- CreateIndex
CREATE INDEX "ContactProfileMerge_sourceId_idx" ON "ContactProfileMerge"("sourceId");

-- CreateIndex
CREATE INDEX "BotConversation_contactProfileId_idx" ON "BotConversation"("contactProfileId");

-- CreateIndex
CREATE INDEX "IncomingCall_contactProfileId_idx" ON "IncomingCall"("contactProfileId");

-- CreateIndex
CREATE INDEX "TelegramConversation_contactProfileId_idx" ON "TelegramConversation"("contactProfileId");

-- CreateIndex
CREATE INDEX "TelegramDirectConversation_contactProfileId_idx" ON "TelegramDirectConversation"("contactProfileId");

-- AddForeignKey
ALTER TABLE "TelegramConversation" ADD CONSTRAINT "TelegramConversation_contactProfileId_fkey" FOREIGN KEY ("contactProfileId") REFERENCES "ContactProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramDirectConversation" ADD CONSTRAINT "TelegramDirectConversation_contactProfileId_fkey" FOREIGN KEY ("contactProfileId") REFERENCES "ContactProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotConversation" ADD CONSTRAINT "BotConversation_contactProfileId_fkey" FOREIGN KEY ("contactProfileId") REFERENCES "ContactProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncomingCall" ADD CONSTRAINT "IncomingCall_contactProfileId_fkey" FOREIGN KEY ("contactProfileId") REFERENCES "ContactProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactProfile" ADD CONSTRAINT "ContactProfile_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactProfile" ADD CONSTRAINT "ContactProfile_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "ContactProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactIdentity" ADD CONSTRAINT "ContactIdentity_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ContactProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactLinkCandidate" ADD CONSTRAINT "ContactLinkCandidate_leftId_fkey" FOREIGN KEY ("leftId") REFERENCES "ContactProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactLinkCandidate" ADD CONSTRAINT "ContactLinkCandidate_rightId_fkey" FOREIGN KEY ("rightId") REFERENCES "ContactProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactProfileMerge" ADD CONSTRAINT "ContactProfileMerge_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "ContactProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactProfileMerge" ADD CONSTRAINT "ContactProfileMerge_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ContactProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

