-- Additive only. Auto narration after property creation / fact changes (11.11.2026).
ALTER TABLE "PropertyNarrationVersion" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "PropertyNarrationVersion" ADD COLUMN "templateId" TEXT;
ALTER TABLE "PropertyNarrationVersion" ADD COLUMN "language" TEXT;
ALTER TABLE "PropertyNarrationVersion" ADD COLUMN "generateAfter" TIMESTAMP(3);
ALTER TABLE "PropertyNarrationVersion" ADD COLUMN "generationAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PropertyNarrationVersion" ADD COLUMN "approvalNotifiedAt" TIMESTAMP(3);
ALTER TABLE "PropertyNarrationVersion" ADD COLUMN "approvalChatId" TEXT;
ALTER TABLE "PropertyNarrationVersion" ADD COLUMN "editRequestedAt" TIMESTAMP(3);
CREATE INDEX "PropertyNarrationVersion_status_generateAfter_idx" ON "PropertyNarrationVersion"("status", "generateAfter");
CREATE INDEX "PropertyNarrationVersion_approvalChatId_editRequestedAt_idx" ON "PropertyNarrationVersion"("approvalChatId", "editRequestedAt");

-- Owner-editable starter templates live in Settings, not in code. Only when none were ever saved.
-- Auto generation itself stays OFF ("autoGenerate" is not set) until leadership enables it.
UPDATE "Settings"
SET "propertyNarrationConfig" = jsonb_set(COALESCE("propertyNarrationConfig", '{}'::jsonb), '{templates}', $json$[
  {"id": "tg-short", "name": "Кӯтоҳ", "lang": "tg",
   "text": "Ассалому алейкум! {вид} барои фурӯш[, ноҳияи {район}]. [{комнаты} ҳуҷра.] Масоҳаташ {площадь} метри мураббаъ. [Ошёнаи {этаж_пор}[ аз {этажей}].] Нарх ва рақами телефон дар тавсифи зери видео. Барои дидан ба мо нависед."},
  {"id": "tg-family", "name": "Барои оила", "lang": "tg",
   "text": "Ассалому алейкум! Агар шумо хона ҷустуҷӯ доред, ин объект барои шумост. {вид}[, ноҳияи {район}]. [{комнаты} ҳуҷра.] Масоҳаташ {площадь} метри мураббаъ. [Ошёнаи {этаж_пор}[ аз {этажей}].] Нарх ва рақами телефон дар тавсифи зери видео. Ба мо нависед, бо хурсандӣ нишон медиҳем."},
  {"id": "ru-short", "name": "Коротко по-русски", "lang": "ru",
   "text": "Здравствуйте! В продаже {вид}[, район {район}]. [Комнат: {комнаты}.] Площадь {площадь} квадратных метров. [Этаж {этаж}[ из {этажей}].] Цена и телефон в описании под видео. Пишите нам, покажем объект."}
]$json$::jsonb)
WHERE "id" = 'singleton' AND NOT (COALESCE("propertyNarrationConfig", '{}'::jsonb) ? 'templates');
