-- Обязательное окно после исчерпания переносов блокирует работу во всей CRM.
-- Три `DROP INDEX` по триграммным индексам поиска из вывода `prisma migrate diff`
-- убраны вручную: они заведены сырой миграцией и в datamodel их нет по определению.

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "summaryHardBlockEnabled" BOOLEAN NOT NULL DEFAULT true;
