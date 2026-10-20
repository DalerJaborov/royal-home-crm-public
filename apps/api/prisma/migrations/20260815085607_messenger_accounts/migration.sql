-- AlterTable
ALTER TABLE "BotConversation" ADD COLUMN     "accountId" TEXT;

-- CreateTable
CREATE TABLE "MessengerAccount" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessengerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessengerAccount_channel_enabled_idx" ON "MessengerAccount"("channel", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "MessengerAccount_channel_externalId_key" ON "MessengerAccount"("channel", "externalId");

-- AddForeignKey
ALTER TABLE "BotConversation" ADD CONSTRAINT "BotConversation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MessengerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
