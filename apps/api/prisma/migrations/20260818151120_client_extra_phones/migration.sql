-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "extraPhones" TEXT[];

-- Пустой массив вместо NULL: у карточек, заведённых до этой миграции, колонка
-- иначе остаётся NULL, и любой разбор массива (unnest, .some в коде) на них падает.
-- Значение по умолчанию — то же самое, чтобы новые строки не заводили NULL заново.
UPDATE "Client" SET "extraPhones" = ARRAY[]::TEXT[] WHERE "extraPhones" IS NULL;
ALTER TABLE "Client" ALTER COLUMN "extraPhones" SET DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Client" ALTER COLUMN "extraPhones" SET NOT NULL;
