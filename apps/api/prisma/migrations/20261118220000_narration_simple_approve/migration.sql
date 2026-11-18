-- Одно утверждение озвучки, сразу выпуск, старые посты снимаются после нового (18.11.2026).
ALTER TABLE "VideoRemakeRequest" ADD COLUMN "oldPosts" JSONB;
ALTER TABLE "VideoRemakeRequest" ADD COLUMN "oldPostsOutcome" JSONB;
ALTER TABLE "PropertyNarrationVersion" ADD COLUMN "audioSec" DOUBLE PRECISION;

-- Замеры длины голоса, которые уже есть (кандидаты «прослушать перед выпуском»): основа оценки длины текста.
UPDATE "PropertyNarrationVersion" v SET "audioSec" = p."narrationPreviewVoiceSec"
FROM "Property" p
WHERE p."narrationPreviewVersionId" = v."id" AND p."narrationPreviewVoiceSec" IS NOT NULL AND v."audioSec" IS NULL;
