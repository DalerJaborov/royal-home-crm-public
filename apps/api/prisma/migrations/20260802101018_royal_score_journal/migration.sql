-- CreateTable
CREATE TABLE "RoyalScoreEvent" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "initiatorId" TEXT,

    CONSTRAINT "RoyalScoreEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoyalScoreEvent_agentId_at_idx" ON "RoyalScoreEvent"("agentId", "at");

-- AddForeignKey
ALTER TABLE "RoyalScoreEvent" ADD CONSTRAINT "RoyalScoreEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoyalScoreEvent" ADD CONSTRAINT "RoyalScoreEvent_initiatorId_fkey" FOREIGN KEY ("initiatorId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
