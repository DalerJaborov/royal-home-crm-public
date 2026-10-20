-- Обложки ChatGPT v3 (25.09.2026): текст кладём мы (OVERLAY), кандидатов по умолчанию — по режиму.
ALTER TABLE "Settings" ADD COLUMN "openaiTextMode" TEXT NOT NULL DEFAULT 'MODEL';
ALTER TABLE "Settings" ALTER COLUMN "openaiCandidates" DROP NOT NULL;
ALTER TABLE "Settings" ALTER COLUMN "openaiCandidates" DROP DEFAULT;
UPDATE "Settings" SET "openaiCandidates" = NULL WHERE "openaiCandidates" = 2;
ALTER TABLE "Settings" ADD COLUMN "openaiPhotoSource" TEXT NOT NULL DEFAULT 'ORIGINAL';
ALTER TABLE "Settings" ADD COLUMN "openaiImageModel" TEXT NOT NULL DEFAULT 'gpt-image-2.5-sunburst';
