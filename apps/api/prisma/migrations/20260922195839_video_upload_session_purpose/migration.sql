-- CreateEnum
CREATE TYPE "VideoUploadSessionPurpose" AS ENUM ('RAW', 'HANDOFF');

-- AlterTable
ALTER TABLE "VideoUploadSession" ADD COLUMN     "purpose" "VideoUploadSessionPurpose" NOT NULL DEFAULT 'RAW';
