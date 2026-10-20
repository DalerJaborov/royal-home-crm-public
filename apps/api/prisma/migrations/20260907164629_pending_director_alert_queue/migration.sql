-- CreateTable
CREATE TABLE "PendingDirectorAlert" (
    "id" TEXT NOT NULL,
    "recipientPermission" TEXT,
    "recipientRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "url" TEXT,
    "kind" TEXT,
    "tag" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "PendingDirectorAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingDirectorAlert_sentAt_createdAt_idx" ON "PendingDirectorAlert"("sentAt", "createdAt");
