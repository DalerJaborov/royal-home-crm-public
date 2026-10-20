-- CreateTable
CREATE TABLE "PropertyShareLink" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "clientId" TEXT,
    "token" TEXT NOT NULL,
    "createdByAgentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "PropertyShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PropertyShareLink_token_key" ON "PropertyShareLink"("token");

-- CreateIndex
CREATE INDEX "PropertyShareLink_propertyId_idx" ON "PropertyShareLink"("propertyId");

-- CreateIndex
CREATE INDEX "PropertyShareLink_clientId_idx" ON "PropertyShareLink"("clientId");

-- AddForeignKey
ALTER TABLE "PropertyShareLink" ADD CONSTRAINT "PropertyShareLink_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyShareLink" ADD CONSTRAINT "PropertyShareLink_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyShareLink" ADD CONSTRAINT "PropertyShareLink_createdByAgentId_fkey" FOREIGN KEY ("createdByAgentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

