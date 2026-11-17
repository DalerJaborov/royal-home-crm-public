-- CreateTable
CREATE TABLE "FreeNarration" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "chatId" TEXT,
    "status" TEXT NOT NULL,
    "script" TEXT NOT NULL DEFAULT '',
    "lang" TEXT,
    "voiceId" TEXT,
    "chars" INTEGER NOT NULL DEFAULT 0,
    "storageKey" TEXT,
    "errorCode" TEXT,
    "providerRequestId" TEXT,
    "requestKey" TEXT,
    "generationStartedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreeNarration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FreeNarration_requestKey_key" ON "FreeNarration"("requestKey");
CREATE INDEX "FreeNarration_agentId_generationStartedAt_idx" ON "FreeNarration"("agentId", "generationStartedAt");
CREATE INDEX "FreeNarration_generationStartedAt_idx" ON "FreeNarration"("generationStartedAt");
CREATE INDEX "FreeNarration_chatId_status_idx" ON "FreeNarration"("chatId", "status");
