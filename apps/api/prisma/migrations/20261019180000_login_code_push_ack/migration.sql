-- Код входа сначала пушем (владелец 19.10.2026): живая подписка и подтверждение доставки.
ALTER TABLE "PushSubscription" ADD COLUMN "lastSeenAt" TIMESTAMP(3);
CREATE INDEX "PushSubscription_agentId_lastSeenAt_idx" ON "PushSubscription"("agentId", "lastSeenAt");
ALTER TABLE "LoginSmsCode" ADD COLUMN "ackTokenHash" TEXT, ADD COLUMN "ackedAt" TIMESTAMP(3), ADD COLUMN "fallbackSentAt" TIMESTAMP(3);
CREATE INDEX "LoginSmsCode_ackTokenHash_idx" ON "LoginSmsCode"("ackTokenHash");
