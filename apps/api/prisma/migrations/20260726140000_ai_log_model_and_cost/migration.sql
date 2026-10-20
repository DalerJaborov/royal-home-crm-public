-- Разбивка расходов на ИИ по видам токенов, модель и стоимость вызова.
-- До этого в журнале была одна сумма «tokens», по которой перерасход не виден:
-- чтение кэша дешевле обычного входа в десять раз, выход дороже входа в пять,
-- и перевести одну цифру в деньги нельзя никаким множителем. Модель тоже не
-- записывалась — старые записи было нечем пересчитать при смене цен.
-- Старые строки остаются как есть: новые поля пустые, поле tokens сохранено.

ALTER TABLE "AiLog" ADD COLUMN "model" TEXT;
ALTER TABLE "AiLog" ADD COLUMN "inputTokens" INTEGER;
ALTER TABLE "AiLog" ADD COLUMN "outputTokens" INTEGER;
ALTER TABLE "AiLog" ADD COLUMN "cacheWriteTokens" INTEGER;
ALTER TABLE "AiLog" ADD COLUMN "cacheReadTokens" INTEGER;
ALTER TABLE "AiLog" ADD COLUMN "costUsd" DECIMAL(12,6);

-- Отчёт о расходах всегда идёт за период, а таблица растёт с каждым обращением.
CREATE INDEX "AiLog_createdAt_idx" ON "AiLog"("createdAt");
