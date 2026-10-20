-- CreateTable
CREATE TABLE "LostClientDigest" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "lostCount" INTEGER NOT NULL DEFAULT 0,
    "wonCount" INTEGER NOT NULL DEFAULT 0,
    "stageCounts" JSONB NOT NULL DEFAULT '{}',
    "reasonCounts" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "LostClientDigest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LostConversation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "conversationId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "draftStage" TEXT,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "clientMessages" INTEGER NOT NULL DEFAULT 0,
    "followUpsSent" INTEGER NOT NULL DEFAULT 0,
    "finding" TEXT NOT NULL,
    "suggestion" TEXT NOT NULL,
    "botMessage" TEXT NOT NULL,
    "clientMessage" TEXT NOT NULL,
    "digestId" TEXT,

    CONSTRAINT "LostConversation_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "BotLesson" ADD COLUMN "digestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "LostClientDigest_periodStart_key" ON "LostClientDigest"("periodStart");

-- CreateIndex
CREATE INDEX "LostClientDigest_periodStart_idx" ON "LostClientDigest"("periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "LostConversation_conversationId_key" ON "LostConversation"("conversationId");

-- CreateIndex
CREATE INDEX "LostConversation_lastMessageAt_idx" ON "LostConversation"("lastMessageAt");

-- CreateIndex
CREATE INDEX "LostConversation_digestId_idx" ON "LostConversation"("digestId");

-- CreateIndex
CREATE INDEX "BotLesson_digestId_idx" ON "BotLesson"("digestId");

-- AddForeignKey
ALTER TABLE "LostConversation" ADD CONSTRAINT "LostConversation_digestId_fkey" FOREIGN KEY ("digestId") REFERENCES "LostClientDigest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotLesson" ADD CONSTRAINT "BotLesson_digestId_fkey" FOREIGN KEY ("digestId") REFERENCES "LostClientDigest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
