-- CreateTable
CREATE TABLE "MontajerMessage" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MontajerMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MontajerMessage_propertyId_sentAt_idx" ON "MontajerMessage"("propertyId", "sentAt");

-- AddForeignKey
ALTER TABLE "MontajerMessage" ADD CONSTRAINT "MontajerMessage_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
