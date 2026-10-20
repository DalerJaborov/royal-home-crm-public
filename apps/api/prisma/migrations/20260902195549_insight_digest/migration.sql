-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "insightDigestEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "InsightDigest" (
    "id" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "meetingAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'READY',
    "coverage" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InsightDigest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsightCase" (
    "id" TEXT NOT NULL,
    "digestId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" INTEGER NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "timeline" JSONB NOT NULL,
    "verdict" JSONB,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "meetingNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InsightCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InsightDigest_periodStart_key" ON "InsightDigest"("periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "InsightCase_sourceKey_key" ON "InsightCase"("sourceKey");

-- CreateIndex
CREATE INDEX "InsightCase_digestId_severity_idx" ON "InsightCase"("digestId", "severity");

-- CreateIndex
CREATE INDEX "InsightCase_agentId_createdAt_idx" ON "InsightCase"("agentId", "createdAt");

-- AddForeignKey
ALTER TABLE "InsightCase" ADD CONSTRAINT "InsightCase_digestId_fkey" FOREIGN KEY ("digestId") REFERENCES "InsightDigest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
