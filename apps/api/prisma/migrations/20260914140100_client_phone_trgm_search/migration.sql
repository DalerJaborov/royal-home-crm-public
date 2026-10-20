-- Поиск клиента по номеру — БЕЗ ИНДЕКСА, ГОДНОГО ПОД ПОДСТРОКУ (аудит надёжности
-- 13.09.2026, находка 1). routes/clients/list.ts ищет номер тремя разными путями:
--   - Client.phone     — обычный `@unique` (равенство), под LIKE/ILIKE '%...%' бесполезен;
--   - Client.whatsappPhone — обычный `@@index` (равенство), тоже бесполезен под подстроку;
--   - Client.extraPhones   — String[], индекса не было вовсе.
-- Тот же приём, что и в 20260805160000_pg_trgm_fuzzy_search (fullName/title/address):
-- GIN по триграммам поддерживает LIKE/ILIKE напрямую (pg_trgm регистрирует классы
-- операторов ~~/~~* поверх gin_trgm_ops), без последовательного скана таблицы.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Client_phone_trgm_idx" ON "Client" USING GIN ("phone" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Client_whatsappPhone_trgm_idx" ON "Client" USING GIN ("whatsappPhone" gin_trgm_ops);

-- extraPhones — МАССИВ, обычный GIN(gin_trgm_ops) на скалярную колонку сюда не
-- ложится: триграммы строит по значению колонки целиком, а не по элементам
-- массива, и разложить их индексом по КАЖДОМУ элементу отдельно (как это делают
-- gin__int_ops/array_ops для операторов @>/&&/=) pg_trgm не умеет — тот класс
-- операторов не про подстроку.
--
-- Рабочий обход — индексировать ВЫРАЖЕНИЕ: конкатенацию элементов через пробел.
-- Разделитель делает совпадение неспособным перескочить с одного номера на
-- другой (toSearchTokens/searchTokens.ts режет запрос по не-буквам-не-цифрам,
-- поэтому токен поиска сам никогда не содержит пробела). Запрос в list.ts
-- переписан на ILIKE по этому же выражению (см. коммит).
--
-- `array_to_string` в каталоге Postgres помечена STABLE, а не IMMUTABLE —
-- индексное выражение требует IMMUTABLE (P3018/42P17 при попытке создать индекс
-- напрямую поверх array_to_string). Стандартный обход: обернуть в SQL-функцию,
-- явно объявленную IMMUTABLE — конкатенация текстовых элементов фиксированным
-- разделителем не зависит ни от locale, ни от текущей сессии, так что объявление
-- честное, а не костыль ради обхода проверки.
CREATE OR REPLACE FUNCTION "client_extra_phones_search_text"(phones text[])
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
AS $$
  SELECT array_to_string(coalesce(phones, ARRAY[]::text[]), ' ')
$$;

CREATE INDEX IF NOT EXISTS "Client_extraPhones_trgm_idx"
  ON "Client" USING GIN (("client_extra_phones_search_text"("extraPhones")) gin_trgm_ops);
