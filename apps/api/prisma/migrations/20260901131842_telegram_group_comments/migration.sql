-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "telegramDiscussionGroupId" TEXT;

-- CreateTable
CREATE TABLE "TelegramGroupComment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "postMessageId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT,
    "text" TEXT NOT NULL,
    "replyDueAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "replyText" TEXT,
    "replyMessageId" TEXT,
    "repliedAt" TIMESTAMP(3),
    "note" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramGroupComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramGroupComment_messageId_key" ON "TelegramGroupComment"("messageId");

-- CreateIndex
CREATE INDEX "TelegramGroupComment_status_replyDueAt_idx" ON "TelegramGroupComment"("status", "replyDueAt");

-- CreateIndex
CREATE INDEX "TelegramGroupComment_postMessageId_authorId_createdAt_idx" ON "TelegramGroupComment"("postMessageId", "authorId", "createdAt");
