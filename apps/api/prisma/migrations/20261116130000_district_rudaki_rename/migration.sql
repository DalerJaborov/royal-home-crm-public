-- Район Рудаки: строка называется «Рудаки (район)», а не «Рудаки» (голое «Рудаки» — главный проспект Душанбе).
-- Для баз, где 20261116120000_district_rudaki применилась в первой версии (строка «Рудаки»): Prisma не перезапускает
-- применённую миграцию, поэтому переименование — отдельной. На базе, где всё уже верно, ничего не меняет.
UPDATE "District" SET "name" = 'Рудаки (район)'
WHERE "name" = 'Рудаки' AND "sourceId" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "District" WHERE "name" = 'Рудаки (район)');
INSERT INTO "District" ("id", "name", "city", "nameTj")
VALUES (gen_random_uuid()::text, 'Рудаки (район)', 'Душанбе', 'Ноҳияи Рӯдакӣ')
ON CONFLICT ("name") DO NOTHING;
