-- CreateTable
CREATE TABLE "LoginLog" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "device" TEXT,
    "deviceKey" TEXT,
    "isNewDevice" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoginLog_agentId_createdAt_idx" ON "LoginLog"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "LoginLog_agentId_deviceKey_idx" ON "LoginLog"("agentId", "deviceKey");

-- AddForeignKey
ALTER TABLE "LoginLog" ADD CONSTRAINT "LoginLog_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
