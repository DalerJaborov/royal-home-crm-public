-- CreateTable
CREATE TABLE "InstagramComment" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "parentId" TEXT,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT,
    "text" TEXT NOT NULL,
    "replyDueAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "replyText" TEXT,
    "replyCommentId" TEXT,
    "repliedAt" TIMESTAMP(3),
    "hiddenAt" TIMESTAMP(3),
    "dmSentAt" TIMESTAMP(3),
    "dmText" TEXT,
    "propertyId" TEXT,
    "note" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstagramComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InstagramComment_commentId_key" ON "InstagramComment"("commentId");

-- CreateIndex
CREATE INDEX "InstagramComment_status_replyDueAt_idx" ON "InstagramComment"("status", "replyDueAt");

-- CreateIndex
CREATE INDEX "InstagramComment_authorId_createdAt_idx" ON "InstagramComment"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "InstagramComment_replyCommentId_idx" ON "InstagramComment"("replyCommentId");
