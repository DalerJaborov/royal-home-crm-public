ALTER TABLE "AssistantTelegramGroup" ADD COLUMN "contextEnabledAt" TIMESTAMP(3);

CREATE TABLE "AssistantTelegramContext" (
  "id" TEXT NOT NULL,
  "groupChatId" TEXT NOT NULL,
  "messageId" INTEGER NOT NULL,
  "threadId" INTEGER,
  "authorAgentId" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "sourceVersion" TIMESTAMP(3) NOT NULL,
  "sourceUpdateId" BIGINT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "text" TEXT NOT NULL,
  "attachmentKind" TEXT,
  "propertyRefs" INTEGER[] NOT NULL,
  CONSTRAINT "AssistantTelegramContext_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AssistantTelegramContext_groupChatId_fkey" FOREIGN KEY ("groupChatId")
    REFERENCES "AssistantTelegramGroup"("chatId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AssistantTelegramContext_groupChatId_messageId_key"
  ON "AssistantTelegramContext"("groupChatId", "messageId");
CREATE INDEX "AssistantTelegramContext_groupChatId_threadId_occurredAt_idx"
  ON "AssistantTelegramContext"("groupChatId", "threadId", "occurredAt");
CREATE INDEX "AssistantTelegramContext_expiresAt_idx" ON "AssistantTelegramContext"("expiresAt");
