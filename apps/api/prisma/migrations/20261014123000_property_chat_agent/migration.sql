ALTER TABLE "BotConversation" ADD COLUMN "propertyChatAgentId" TEXT,
  ADD COLUMN "propertyChatAgentAt" TIMESTAMP(3);
CREATE INDEX "BotConversation_propertyChatAgentId_idx" ON "BotConversation"("propertyChatAgentId");
ALTER TABLE "BotConversation" ADD CONSTRAINT "BotConversation_propertyChatAgentId_fkey"
  FOREIGN KEY ("propertyChatAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
