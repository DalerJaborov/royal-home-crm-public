-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "videoTemplateEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "videoTemplateKey" TEXT;
