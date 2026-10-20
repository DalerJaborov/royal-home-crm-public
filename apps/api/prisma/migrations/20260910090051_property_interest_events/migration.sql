-- CreateTable
CREATE TABLE "PropertyInterestEvent" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "clientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropertyInterestEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PropertyInterestEvent_propertyId_createdAt_idx" ON "PropertyInterestEvent"("propertyId", "createdAt");

-- CreateIndex
CREATE INDEX "PropertyInterestEvent_createdAt_idx" ON "PropertyInterestEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "PropertyInterestEvent" ADD CONSTRAINT "PropertyInterestEvent_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
