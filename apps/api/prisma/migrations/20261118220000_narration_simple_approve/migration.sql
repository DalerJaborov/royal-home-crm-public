-- Одно утверждение озвучки, сразу выпуск, старые посты снимаются после нового (18.11.2026).
ALTER TABLE "VideoRemakeRequest" ADD COLUMN "oldPosts" JSONB;
ALTER TABLE "VideoRemakeRequest" ADD COLUMN "oldPostsOutcome" JSONB;
ALTER TABLE "VideoRemakeRequest" ADD COLUMN "oldPostsCheckedAt" TIMESTAMP(3);
ALTER TABLE "VideoRemakeRequest" ADD COLUMN "carriedOldPosts" JSONB;
ALTER TABLE "VideoRemakeRequest" ADD COLUMN "narrationVersionId" TEXT;
ALTER TABLE "PropertyNarrationVersion" ADD COLUMN "audioSec" DOUBLE PRECISION;

-- ДАННЫЕ (тест apps/api/tests/narration-release-order.test.ts гоняет всё ниже этой строки на своей базе).
-- Замеры длины голоса, которые уже есть (кандидаты «прослушать перед выпуском»): основа оценки длины текста.
UPDATE "PropertyNarrationVersion" v SET "audioSec" = p."narrationPreviewVoiceSec"
FROM "Property" p
WHERE p."narrationPreviewVersionId" = v."id" AND p."narrationPreviewVoiceSec" IS NOT NULL AND v."audioSec" IS NULL;

-- БЕЗ ЧЕЛОВЕКА В СЕТЬ НЕ ВЫХОДИТ (ревью 18.11). С этого выката утверждённая озвучка вышедшего ролика выпускается
-- сразу. Последние ещё не наложенные версии вышедших роликов, которые человек НЕ утверждал на выпуск, снова ждут
-- «Утвердить и выпустить»:
--   * ждали решения «прослушать перед выпуском» (кандидат);
--   * от них отказались «Оставить старый»;
--   * утверждены автоматически (самоодобрение ставит approvalNotifiedAt = approvedAt).
-- Не трогаем: уже наложенные (videoMasterNarrationVersionId), упавшие при наложении, отправленные монтажёру (их голос
-- уже в ролике или едет к нему). Шаг идёт при выкате, пока старые api и worker ещё работают: что они успеют
-- сделать после него (кандидат, самоодобрение), не выпускается сторожем в remixWanted и уборкой кандидатов.
WITH latest AS (
  SELECT DISTINCT ON (v."propertyId") v."id", v."propertyId", v."status", v."approvedAt", v."approvalNotifiedAt"
  FROM "PropertyNarrationVersion" v
  ORDER BY v."propertyId", v."revision" DESC
)
UPDATE "PropertyNarrationVersion" t
SET "approvedAt" = NULL, "approvedById" = NULL, "approvalNotifiedAt" = NULL, "approvalRemindedAt" = NULL, "approvalEscalatedAt" = NULL
FROM latest l
JOIN "Property" p ON p."id" = l."propertyId"
WHERE t."id" = l."id"
  AND l."status" = 'READY' AND l."approvedAt" IS NOT NULL
  AND p."deletedAt" IS NULL
  AND (cardinality(p."publishedChannels") > 0 OR p."instagramUrl" IS NOT NULL)
  AND p."videoMasterNarrationVersionId" IS DISTINCT FROM l."id"
  AND p."videoMasterMixErrorVersionId" IS DISTINCT FROM l."id"
  AND NOT EXISTS (SELECT 1 FROM "PropertyNarrationDelivery" d WHERE d."versionId" = l."id" AND d."status" IN ('SENT', 'QUEUED', 'SENDING', 'UNKNOWN'))
  AND (l."id" = p."narrationPreviewVersionId" OR l."id" = p."narrationPreviewDeclinedVersionId" OR l."approvalNotifiedAt" = l."approvedAt");
