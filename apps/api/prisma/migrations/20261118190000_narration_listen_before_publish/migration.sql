-- Прослушать перед выпуском (17.11.2026): новая озвучка на вышедший ролик ждёт решения хозяина.
ALTER TABLE "Property" ADD COLUMN "narrationPreviewPath" TEXT;
ALTER TABLE "Property" ADD COLUMN "narrationPreviewVersionId" TEXT;
ALTER TABLE "Property" ADD COLUMN "narrationPreviewMasterKey" TEXT;
ALTER TABLE "Property" ADD COLUMN "narrationPreviewAt" TIMESTAMP(3);
ALTER TABLE "Property" ADD COLUMN "narrationPreviewDueAt" TIMESTAMP(3);
ALTER TABLE "Property" ADD COLUMN "narrationPreviewVoiceSec" DOUBLE PRECISION;
ALTER TABLE "Property" ADD COLUMN "narrationPreviewClipSec" DOUBLE PRECISION;
ALTER TABLE "Property" ADD COLUMN "narrationPreviewDeclinedVersionId" TEXT;
ALTER TABLE "Property" ADD COLUMN "narrationPreviewNotifiedAt" TIMESTAMP(3);
