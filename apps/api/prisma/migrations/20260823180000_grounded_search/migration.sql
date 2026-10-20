-- Google Search grounding (23.08.2026, пункт 4 очереди ИИ): рубильник для
-- справочных вопросов через ВНУТРЕННЕГО ИИ-ассистента CRM (ai/assistant.ts,
-- классификатор REFERENCE_REAL_ESTATE) — модель сама ищет в живом вебе и отвечает
-- с источниками. Клиентского бота (ai/leadQualifier.ts) не касается.
--
-- Выключено по умолчанию: тумблер на каждую новую функцию.
ALTER TABLE "Settings" ADD COLUMN IF NOT EXISTS "groundedSearchEnabled" BOOLEAN NOT NULL DEFAULT false;
