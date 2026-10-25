ALTER TABLE "Settings" ADD COLUMN "propertyNarrationConfig" JSONB NOT NULL DEFAULT '{}';
CREATE TABLE "PropertyNarrationVersion" (
 "id" TEXT NOT NULL PRIMARY KEY, "propertyId" TEXT NOT NULL REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "revision" INTEGER NOT NULL, "script" TEXT NOT NULL, "factsSnapshot" JSONB NOT NULL, "factsHash" TEXT NOT NULL,
 "voiceId" TEXT, "modelId" TEXT, "status" TEXT NOT NULL DEFAULT 'DRAFT', "storageKey" TEXT, "errorCode" TEXT,
 "providerRequestId" TEXT, "approvedAt" TIMESTAMP(3), "approvedById" TEXT, "createdById" TEXT NOT NULL,
 "requestKey" TEXT NOT NULL, "generationStartedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PropertyNarrationVersion_requestKey_key" ON "PropertyNarrationVersion"("requestKey");
CREATE UNIQUE INDEX "PropertyNarrationVersion_propertyId_revision_key" ON "PropertyNarrationVersion"("propertyId", "revision");
CREATE TABLE "PropertyNarrationDelivery" (
 "id" TEXT NOT NULL PRIMARY KEY, "propertyId" TEXT NOT NULL REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "versionId" TEXT NOT NULL REFERENCES "PropertyNarrationVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "editorId" TEXT, "mode" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'PREVIEW', "requestKey" TEXT NOT NULL,
 "createdById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PropertyNarrationDelivery_requestKey_key" ON "PropertyNarrationDelivery"("requestKey");
CREATE INDEX "PropertyNarrationDelivery_propertyId_createdAt_idx" ON "PropertyNarrationDelivery"("propertyId", "createdAt");
CREATE TABLE "PublicationMetadataSync" (
 "id" TEXT NOT NULL PRIMARY KEY, "propertyId" TEXT NOT NULL REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "revisionHash" TEXT NOT NULL, "channel" TEXT NOT NULL, "operation" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'PREVIEW',
 "reason" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PublicationMetadataSync_propertyId_revisionHash_channel_operation_key" ON "PublicationMetadataSync"("propertyId", "revisionHash", "channel", "operation");
CREATE TABLE "OwnerReportDelivery" (
 "id" TEXT NOT NULL PRIMARY KEY, "propertyId" TEXT NOT NULL REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "sellerClientId" TEXT NOT NULL, "period" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'PREVIEW', "reportUrl" TEXT,
 "createdById" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "OwnerReportDelivery_propertyId_sellerClientId_period_key" ON "OwnerReportDelivery"("propertyId", "sellerClientId", "period");
