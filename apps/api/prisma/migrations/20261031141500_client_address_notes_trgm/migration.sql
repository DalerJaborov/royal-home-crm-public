-- Поиск клиента по адресу и «заметкам» (requirementsNotes) — ИНДЕКСЫ ПОД ПОДСТРОКУ
-- (31.10.2026, внутренний ИИ-помощник, П3 «read», инструмент find_clients).
--
-- lib/clientSearchWhere.ts (общий для GET /clients и помощника) искал по этим двум
-- полям через `contains`/ILIKE '%…%' ещё с 04.09.2026, но индекса под подстроку у них
-- не было — полный перебор таблицы на каждую строку поиска. Тот же приём, что у
-- fullName/phone (20260805160000_pg_trgm_fuzzy_search, 20260914140100_client_phone_trgm_search):
-- GIN по триграммам поддерживает ILIKE напрямую.
--
-- Построение на таблице Client безопасно без CONCURRENTLY (сотни–тысячи строк, как при
-- прежних триграммных миграциях). IF NOT EXISTS — стенды агентов копируют эталон базы.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Client_address_trgm_idx" ON "Client" USING GIN ("address" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Client_requirementsNotes_trgm_idx" ON "Client" USING GIN ("requirementsNotes" gin_trgm_ops);
