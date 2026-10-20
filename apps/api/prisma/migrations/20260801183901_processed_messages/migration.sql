-- CreateTable
CREATE TABLE "ProcessedMessage" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProcessedMessage_createdAt_idx" ON "ProcessedMessage"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedMessage_channel_messageId_key" ON "ProcessedMessage"("channel", "messageId");
