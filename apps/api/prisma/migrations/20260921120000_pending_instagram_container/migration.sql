-- CreateTable
CREATE TABLE "PendingInstagramContainer" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storyKind" TEXT,
    "partIndex" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "PendingInstagramContainer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingInstagramContainer_containerId_key" ON "PendingInstagramContainer"("containerId");

-- CreateIndex
CREATE INDEX "PendingInstagramContainer_status_createdAt_idx" ON "PendingInstagramContainer"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "PendingInstagramContainer" ADD CONSTRAINT "PendingInstagramContainer_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
