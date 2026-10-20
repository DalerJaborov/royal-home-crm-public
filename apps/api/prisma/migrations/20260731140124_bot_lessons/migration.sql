-- CreateTable
CREATE TABLE "BotLesson" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "conversationId" TEXT,
    "botMessage" TEXT NOT NULL,
    "humanMessage" TEXT NOT NULL,
    "lesson" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "BotLesson_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotLesson_createdAt_idx" ON "BotLesson"("createdAt");

-- CreateIndex
CREATE INDEX "BotLesson_lesson_active_idx" ON "BotLesson"("lesson", "active");
