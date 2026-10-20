-- Снимок передачи дел для кнопки «Вернуть всё как было» (владелец 24.09.2026).
-- CreateTable
CREATE TABLE "AgentHandoverBatch" (
    "id" TEXT NOT NULL,
    "fromAgentId" TEXT NOT NULL,
    "actorId" TEXT,
    "toAgentId" TEXT,
    "clients" INTEGER NOT NULL DEFAULT 0,
    "tasks" INTEGER NOT NULL DEFAULT 0,
    "properties" INTEGER NOT NULL DEFAULT 0,
    "deactivated" BOOLEAN NOT NULL DEFAULT false,
    "items" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revertedAt" TIMESTAMP(3),
    "revertedById" TEXT,
    "revertSummary" JSONB,

    CONSTRAINT "AgentHandoverBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentHandoverBatch_fromAgentId_createdAt_idx" ON "AgentHandoverBatch"("fromAgentId", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentHandoverBatch" ADD CONSTRAINT "AgentHandoverBatch_fromAgentId_fkey" FOREIGN KEY ("fromAgentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
