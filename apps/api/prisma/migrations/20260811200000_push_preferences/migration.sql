-- Личные настройки уведомлений по видам + рубильники новых поводов.
-- Три `DROP INDEX` по триграммным индексам поиска из вывода `prisma migrate diff`
-- убраны вручную: они заведены сырой миграцией, в datamodel их нет по определению,
-- а их удаление молча убивает поиск.

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "pushMuted" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "pushMessageThrottleMinutes" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "pushOnScoreChange" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "pushScoreThrottleMinutes" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "pushShowingsToSupervisors" BOOLEAN NOT NULL DEFAULT true;
