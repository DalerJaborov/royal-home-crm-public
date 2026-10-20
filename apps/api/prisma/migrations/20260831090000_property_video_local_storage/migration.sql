-- AlterTable
ALTER TABLE "PropertyVideo" RENAME COLUMN "r2Key" TO "storageKey";
ALTER TABLE "VideoUploadSession" RENAME COLUMN "r2Key" TO "storageKey";
ALTER TABLE "VideoUploadSession" DROP COLUMN "r2UploadId";
