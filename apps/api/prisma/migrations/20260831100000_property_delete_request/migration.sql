-- Заявка агента на удаление карточки объекта (зеркало ClientDeleteRequest,
-- 31.08.2026): агент просит, решает руководство.
-- CreateTable
CREATE TABLE "PropertyDeleteRequest" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyDeleteRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PropertyDeleteRequest_status_createdAt_idx" ON "PropertyDeleteRequest"("status", "createdAt");
CREATE INDEX "PropertyDeleteRequest_propertyId_status_idx" ON "PropertyDeleteRequest"("propertyId", "status");

-- AddForeignKey
ALTER TABLE "PropertyDeleteRequest" ADD CONSTRAINT "PropertyDeleteRequest_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PropertyDeleteRequest" ADD CONSTRAINT "PropertyDeleteRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PropertyDeleteRequest" ADD CONSTRAINT "PropertyDeleteRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
