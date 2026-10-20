CREATE TABLE "BotTurnTrace" (
  "id" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "coverage" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "checkpointSeq" INTEGER NOT NULL,
  "outcome" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "eventKey" TEXT,
  "conversationKey" TEXT,
  "accountKey" TEXT,
  "payload" JSONB NOT NULL,
  CONSTRAINT "BotTurnTrace_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BotTurnTrace_expiresAt_idx" ON "BotTurnTrace"("expiresAt");
CREATE INDEX "BotTurnTrace_createdAt_channel_idx" ON "BotTurnTrace"("createdAt", "channel");
CREATE INDEX "BotTurnTrace_eventKey_createdAt_idx" ON "BotTurnTrace"("eventKey", "createdAt");
CREATE INDEX "BotTurnTrace_conversationKey_createdAt_idx" ON "BotTurnTrace"("conversationKey", "createdAt");
