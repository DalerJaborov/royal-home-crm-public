-- CreateTable
CREATE TABLE "LiveEventOutbox" (
    "seq" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "agentIds" TEXT[],
    "roles" TEXT[],
    "origin" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveEventOutbox_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE INDEX "LiveEventOutbox_createdAt_idx" ON "LiveEventOutbox"("createdAt");
