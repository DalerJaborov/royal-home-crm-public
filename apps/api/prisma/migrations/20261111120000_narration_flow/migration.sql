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
  {"id": "tg-short", "name": "Кӯтоҳ ва равшан", "lang": "tg",
   "text": "Ассалому алайкум! Роял Хом пешниҳод мекунад: {вид}[ дар ноҳияи {район}]. [{комнаты} ҳуҷра.] Масоҳаташ {площадь} метри мураббаъ. [Ошёнаи {этаж_пор}[ аз {этажей}].] Нархаш {цена}. Барои дидан ҳамин ҳозир ба мо нависед!"},
  {"id": "tg-family", "name": "Барои оила", "lang": "tg",
   "text": "Ассалому алайкум! Барои оилаатон хона меҷӯед? Ба ин объект диққат диҳед: {вид}[ дар ноҳияи {район}]. [{комнаты} ҳуҷра.] Масоҳаташ {площадь} метри мураббаъ. [Ошёнаи {этаж_пор}[ аз {этажей}].] Нархаш {цена}. Ба Роял Хом нависед, бо хурсандӣ нишон медиҳем!"},
  {"id": "tg-offer", "name": "Пешниҳоди хуб", "lang": "tg",
   "text": "Ин имкониятро аз даст надиҳед! Роял Хом: {вид}[, ноҳияи {район}]. [{комнаты} ҳуҷра.] Масоҳаташ {площадь} метри мураббаъ. [Ошёнаи {этаж_пор}[ аз {этажей}].] Нархаш {цена}. Рақами телефон дар тавсифи зери видео. Занг занед ё нависед!"},
  {"id": "ru-short", "name": "Коротко", "lang": "ru",
   "text": "Здравствуйте! Роял Хом предлагает: в продаже {вид}[ в районе {район}]. [Комнат: {комнаты}.] Площадь {площадь} квадратных метров. [Этаж {этаж}[ из {этажей}].] Цена {цена}. Пишите нам прямо сейчас, покажем в удобное для вас время!"},
  {"id": "ru-family", "name": "Для семьи", "lang": "ru",
   "text": "Здравствуйте! Ищете жильё для своей семьи? Обратите внимание: в продаже {вид}[ в районе {район}]. [Комнат: {комнаты}.] Площадь {площадь} квадратных метров. [Этаж {этаж}[ из {этажей}].] Цена {цена}. Пишите в Роял Хом, с радостью покажем!"},
  {"id": "ru-offer", "name": "Выгодное предложение", "lang": "ru",
   "text": "Не упустите хорошее предложение от Роял Хом! В продаже {вид}[, район {район}]. [Комнат: {комнаты}.] Площадь {площадь} квадратных метров. [Этаж {этаж}[ из {этажей}].] Цена {цена}. Телефон в описании под видео, звоните или пишите!"}
]$json$::jsonb)
WHERE "id" = 'singleton' AND NOT (COALESCE("propertyNarrationConfig", '{}'::jsonb) ? 'templates');
