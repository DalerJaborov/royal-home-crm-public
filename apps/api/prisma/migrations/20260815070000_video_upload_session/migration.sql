-- CreateTable
CREATE TABLE "VideoUploadSession" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "uploadKey" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "r2UploadId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "contentType" TEXT NOT NULL,
    "partSize" INTEGER NOT NULL,
    "totalParts" INTEGER NOT NULL,
    "parts" JSONB NOT NULL DEFAULT '[]',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoUploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VideoUploadSession_uploadKey_key" ON "VideoUploadSession"("uploadKey");

-- CreateIndex
CREATE INDEX "VideoUploadSession_propertyId_idx" ON "VideoUploadSession"("propertyId");

-- CreateIndex
CREATE INDEX "VideoUploadSession_updatedAt_idx" ON "VideoUploadSession"("updatedAt");

-- AddForeignKey
ALTER TABLE "VideoUploadSession" ADD CONSTRAINT "VideoUploadSession_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoUploadSession" ADD CONSTRAINT "VideoUploadSession_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

