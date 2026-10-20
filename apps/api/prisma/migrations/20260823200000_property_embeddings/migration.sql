-- Семантический подбор объектов (23.08.2026, пункт 3 очереди ИИ) — вектор Gemini
-- Embedding по тексту карточки, для косинусного сходства с запросом клиента.
--
-- НЕ pgvector: расширение недоступно в образе Postgres проекта (проверено —
-- SELECT * FROM pg_available_extensions WHERE name='vector' пусто), а каталог
-- агентства (сотни-низкие тысячи объектов) не требует индекса ANN — полный
-- линейный проход в Node (apps/api/src/lib/embeddingSearch.ts) занимает миллисекунды.
--
-- Prisma не допускает необязательный список в схеме (`Float[]?` — ошибка),
-- поэтому колонка НЕ nullable, пустой массив по умолчанию — существующие объекты
-- не меняют поведения. Признак «эмбеддинг есть» — embeddingUpdatedAt (NULL = нет
-- или устарел), а не длина массива.
ALTER TABLE "Property" ADD COLUMN IF NOT EXISTS "embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[];
ALTER TABLE "Property" ADD COLUMN IF NOT EXISTS "embeddingUpdatedAt" TIMESTAMP(3);

-- Тумблер ИСПОЛЬЗОВАНИЯ семантики в поиске ИИ-ассистента (ai/assistant.ts,
-- search_properties/semanticQuery). Индексация (пересчёт вектора при сохранении
-- объекта) от тумблера не зависит и работает всегда, если настроен ключ Gemini.
-- Выключено по умолчанию — тумблер на каждую новую функцию, как groundedSearchEnabled.
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "semanticSearchEnabled" BOOLEAN NOT NULL DEFAULT false;
