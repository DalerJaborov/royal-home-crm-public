-- СМС через Payom (24.09.2026): статус доставки из вебхука.
ALTER TABLE "SmsMessage" ADD COLUMN "deliveryStatus" TEXT,
ADD COLUMN "deliveryStatusAt" TIMESTAMP(3);

CREATE INDEX "SmsMessage_providerMessageId_idx" ON "SmsMessage"("providerMessageId");
