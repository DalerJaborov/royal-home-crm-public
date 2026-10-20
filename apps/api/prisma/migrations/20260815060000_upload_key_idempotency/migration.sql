-- AlterTable
ALTER TABLE "PropertyPhoto" ADD COLUMN     "uploadKey" TEXT;

-- AlterTable
ALTER TABLE "PropertyVideo" ADD COLUMN     "uploadKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PropertyPhoto_uploadKey_key" ON "PropertyPhoto"("uploadKey");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyVideo_uploadKey_key" ON "PropertyVideo"("uploadKey");

