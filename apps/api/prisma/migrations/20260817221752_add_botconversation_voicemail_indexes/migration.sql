-- CreateIndex
CREATE INDEX "BotConversation_accountId_idx" ON "BotConversation"("accountId");

-- CreateIndex
CREATE INDEX "VoicemailMessage_clientId_idx" ON "VoicemailMessage"("clientId");

-- CreateIndex
CREATE INDEX "VoicemailMessage_phone_idx" ON "VoicemailMessage"("phone");
