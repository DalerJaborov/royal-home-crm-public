-- Опечатко-устойчивый поиск (docs/lead-lifecycle-plan.md, второй пакет, п.5):
-- «воданасос» и «ваданасос» — одно и то же слово, но разные строки для ILIKE/токенов
-- из lib/searchTokens.ts. pg_trgm даёт триграммное сходство (similarity()), которым
-- покрывается именно этот случай — опечатка/гласная-вариация, а не порядок слов или
-- раскладка (то уже решено в searchTokens.ts).
--
-- CREATE EXTENSION требует прав суперпользователя/CREATEDB на некоторых управляемых
-- хостингах Postgres — если роль приложения этого не может, накатить эту одну строку
-- вручную от администратора БД один раз, миграция идемпотентна (IF NOT EXISTS) и
-- безопасно перезапускается. В стандартном образе postgres:16 (используется в
-- docker-compose.yml для разработки) расширение идёт в комплекте (contrib) и доступно
-- пользователю-владельцу базы без отдельной установки пакета.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN-индексы на триграммы полей, участвующих в текстовом поиске
-- (routes/properties.ts: title, address; routes/clients.ts: fullName).
-- Без индекса similarity() всё равно работает (последовательным сканированием),
-- но на боевом объёме карточек это недопустимо медленно для запроса из UI.
CREATE INDEX IF NOT EXISTS "Property_title_trgm_idx" ON "Property" USING GIN ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Property_address_trgm_idx" ON "Property" USING GIN ("address" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Client_fullName_trgm_idx" ON "Client" USING GIN ("fullName" gin_trgm_ops);
