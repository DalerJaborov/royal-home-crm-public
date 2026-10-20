-- CreateTable
CREATE TABLE "BotConversation" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "name" TEXT,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "leadDraft" JSONB,
    "clientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotConversation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BotConversation_clientId_key" ON "BotConversation"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "BotConversation_channel_subscriberId_key" ON "BotConversation"("channel", "subscriberId");

-- AddForeignKey
ALTER TABLE "BotConversation" ADD CONSTRAINT "BotConversation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;
