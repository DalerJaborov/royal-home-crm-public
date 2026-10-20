-- Зарплатная строка перестаёт плыть вслед за курсом (27.08.2026, аудит №4).
-- autoFingerprint — отпечаток исходных сделок месяца: пересчёт только когда
-- изменился их набор, а не когда сдвинулся курс валют.
-- manualEditedAt — правку директора автоматика больше не откатывает.
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "autoFingerprint" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "manualEditedAt" TIMESTAMP(3);
