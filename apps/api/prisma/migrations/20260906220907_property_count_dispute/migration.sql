-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "sellerDeclaredPropertyCount" INTEGER,
ADD COLUMN     "sellerDeclaredPropertyCountAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PropertyCountDispute" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "aiCount" INTEGER NOT NULL,
    "proposedCount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyCountDispute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PropertyCountDispute_status_createdAt_idx" ON "PropertyCountDispute"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PropertyCountDispute_clientId_status_idx" ON "PropertyCountDispute"("clientId", "status");

-- AddForeignKey
ALTER TABLE "PropertyCountDispute" ADD CONSTRAINT "PropertyCountDispute_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyCountDispute" ADD CONSTRAINT "PropertyCountDispute_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyCountDispute" ADD CONSTRAINT "PropertyCountDispute_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
