-- Ключ автора объявления (HMAC от ID пользователя Somon; сырой ID в этой колонке не пишется):
-- считаем, сколько объявлений одного автора видно в категории «Квартиры, продажа, Душанбе».
ALTER TABLE "SomonSeenAdvert" ADD COLUMN "sellerKey" TEXT;
CREATE INDEX "SomonSeenAdvert_sellerKey_idx" ON "SomonSeenAdvert"("sellerKey");

-- Записям, сделанным до этого поля, ключ дописывается МЯГКО, без сброса baseline
-- (решение 01.11.2026: монитор на проде уже активен, сброс остановил бы рассылку на
-- время нового обхода и потерял бы объявления за это время).
--  * Отдельный проход по выдаче (monitor.ts -> discoveryStore.rekeySellerPage), одна
--    страница за тик после доставки: только дописывает ключ, новых записей не создаёт.
--  * Пока проход идёт, счёт по автору может быть занижен, поэтому собственником
--    сразу считается только автор с ОДНИМ объявлением на всём сайте; остальные
--    откладываются (SELLER_UNKNOWN) и возвращаются в очередь, когда проход закончен.
--  * Пустая таблица (монитор ещё не запускался) — проход не нужен: baseline пишет ключ сам.
ALTER TABLE "SomonMonitor" ADD COLUMN "sellerKeyRekeyPage" INTEGER;
UPDATE "SomonMonitor" SET "sellerKeyRekeyPage" = 1 WHERE EXISTS (SELECT 1 FROM "SomonSeenAdvert");
