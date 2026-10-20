-- CreateTable
CREATE TABLE "BotAuditFinding" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "why" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "BotAuditFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BotAuditFinding_createdAt_idx" ON "BotAuditFinding"("createdAt");

-- CreateIndex
CREATE INDEX "BotAuditFinding_resolvedAt_idx" ON "BotAuditFinding"("resolvedAt");

-- CreateIndex
CREATE INDEX "BotAuditFinding_type_idx" ON "BotAuditFinding"("type");
