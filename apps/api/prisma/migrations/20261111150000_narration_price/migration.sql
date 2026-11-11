-- Additive. Owner decision 11.11.2026 «Да, говорить цену»: starter templates gain {цена}.
-- A template is replaced ONLY while its text still equals the starter text from 20261111120000;
-- anything the owner already edited (or added) stays exactly as it is.
UPDATE "Settings" AS s
SET "propertyNarrationConfig" = jsonb_set(s."propertyNarrationConfig", '{templates}', (
  SELECT jsonb_agg(
    CASE WHEN n.item IS NOT NULL AND t.item->>'text' = n.item->>'old'
      THEN t.item || jsonb_build_object('text', n.item->>'text')
      ELSE t.item END
    ORDER BY t.ord)
  FROM jsonb_array_elements(s."propertyNarrationConfig"->'templates') WITH ORDINALITY AS t(item, ord)
  LEFT JOIN jsonb_array_elements($json$[
  {
    "id": "tg-short",
    "old": "Ассалому алейкум! {вид} барои фурӯш[, ноҳияи {район}]. [{комнаты} ҳуҷра.] Масоҳаташ {площадь} метри мураббаъ. [Ошёнаи {этаж_пор}[ аз {этажей}].] Нарх ва рақами телефон дар тавсифи зери видео. Барои дидан ба мо нависед.",
    "text": "Ассалому алейкум! {вид} барои фурӯш[, ноҳияи {район}]. [{комнаты} ҳуҷра.] Масоҳаташ {площадь} метри мураббаъ. [Ошёнаи {этаж_пор}[ аз {этажей}].] Нархаш {цена}. Рақами телефон дар тавсифи зери видео. Барои дидан ба мо нависед."
  },
  {
    "id": "tg-family",
    "old": "Ассалому алейкум! Агар шумо хона ҷустуҷӯ доред, ин объект барои шумост. {вид}[, ноҳияи {район}]. [{комнаты} ҳуҷра.] Масоҳаташ {площадь} метри мураббаъ. [Ошёнаи {этаж_пор}[ аз {этажей}].] Нарх ва рақами телефон дар тавсифи зери видео. Ба мо нависед, бо хурсандӣ нишон медиҳем.",
    "text": "Ассалому алейкум! Агар шумо хона ҷустуҷӯ доред, ин объект барои шумост. {вид}[, ноҳияи {район}]. [{комнаты} ҳуҷра.] Масоҳаташ {площадь} метри мураббаъ. [Ошёнаи {этаж_пор}[ аз {этажей}].] Нархаш {цена}. Рақами телефон дар тавсифи зери видео. Ба мо нависед, бо хурсандӣ нишон медиҳем."
  },
  {
    "id": "ru-short",
    "old": "Здравствуйте! В продаже {вид}[, район {район}]. [Комнат: {комнаты}.] Площадь {площадь} квадратных метров. [Этаж {этаж}[ из {этажей}].] Цена и телефон в описании под видео. Пишите нам, покажем объект.",
    "text": "Здравствуйте! В продаже {вид}[, район {район}]. [Комнат: {комнаты}.] Площадь {площадь} квадратных метров. [Этаж {этаж}[ из {этажей}].] Цена {цена}. Телефон в описании под видео. Пишите нам, покажем объект."
  }
]$json$::jsonb) AS n(item) ON n.item->>'id' = t.item->>'id'
))
WHERE s."id" = 'singleton'
  AND jsonb_typeof(s."propertyNarrationConfig"->'templates') = 'array'
  AND jsonb_array_length(s."propertyNarrationConfig"->'templates') > 0;
