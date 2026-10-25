-- Classify only known, system-generated investigation event formats. Preserve
-- original rows, authors, timestamps, attachments and evidence for management.
UPDATE "Interaction" SET "investigationOnly" = true
WHERE "type" = 'SYSTEM' AND (
  "notes" LIKE 'Служба безопасности: %'
  OR "notes" LIKE 'Антифрод «продавец без объекта»: %'
  OR ("notes" LIKE 'Объект №% снят с продажи: продан в обход агентства%'
      AND "notes" LIKE '%Карточка передана в СБ.%')
  OR ("notes" LIKE 'Клиент отказался (%'
      AND "notes" LIKE '%причина требует проверки службы безопасности, карточка передана на проверку%')
);

-- These are derived AI caches, not original evidence. Rebuild from the now
-- public-only interaction projection rather than keeping a private paraphrase.
UPDATE "Client" SET "aiInsight" = NULL, "aiScoreReason" = NULL
WHERE "securityReview" IS NOT NULL
   OR id IN (SELECT "clientId" FROM "Interaction" WHERE "investigationOnly" = true);
