-- CreateTable
CREATE TABLE "AiAssistantAuditLog" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "argsSummary" TEXT,
    "resultCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAssistantAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiAssistantAuditLog_agentId_createdAt_idx" ON "AiAssistantAuditLog"("agentId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiAssistantAuditLog" ADD CONSTRAINT "AiAssistantAuditLog_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
