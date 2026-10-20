-- CreateEnum
CREATE TYPE "PropertyChangeKind" AS ENUM ('PRICE_CHANGE', 'CARD_DATA', 'REMAKE_VIDEO', 'UNPUBLISH', 'OTHER');

-- CreateEnum
CREATE TYPE "PropertyChangeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'FAILED');

-- CreateTable
CREATE TABLE "PropertyChangeRequest" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "kind" "PropertyChangeKind" NOT NULL,
    "status" "PropertyChangeStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "comment" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "result" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PropertyChangeRequest_propertyId_status_idx" ON "PropertyChangeRequest"("propertyId", "status");

-- CreateIndex
CREATE INDEX "PropertyChangeRequest_status_createdAt_idx" ON "PropertyChangeRequest"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "PropertyChangeRequest" ADD CONSTRAINT "PropertyChangeRequest_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyChangeRequest" ADD CONSTRAINT "PropertyChangeRequest_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyChangeRequest" ADD CONSTRAINT "PropertyChangeRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
