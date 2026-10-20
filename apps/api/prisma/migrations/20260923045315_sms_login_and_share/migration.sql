-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "smsApiToken" TEXT,
ADD COLUMN     "smsLogin" TEXT,
ADD COLUMN     "smsLoginCodeEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "smsProvider" TEXT,
ADD COLUMN     "smsSender" TEXT;

-- CreateTable
CREATE TABLE "SmsMessage" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider" TEXT,
    "providerMessageId" TEXT,
    "parts" INTEGER,
    "error" TEXT,
    "agentId" TEXT,
    "clientId" TEXT,
    "propertyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginSmsCode" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginSmsCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SmsMessage_createdAt_idx" ON "SmsMessage"("createdAt");

-- CreateIndex
CREATE INDEX "SmsMessage_clientId_propertyId_createdAt_idx" ON "SmsMessage"("clientId", "propertyId", "createdAt");

-- CreateIndex
CREATE INDEX "SmsMessage_phone_purpose_createdAt_idx" ON "SmsMessage"("phone", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "LoginSmsCode_agentId_createdAt_idx" ON "LoginSmsCode"("agentId", "createdAt");

-- AddForeignKey
ALTER TABLE "LoginSmsCode" ADD CONSTRAINT "LoginSmsCode_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
