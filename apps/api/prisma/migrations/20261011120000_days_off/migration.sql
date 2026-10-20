-- Выходные компании и агента (владелец 11.10.2026: «у нас нет никаких выходных»).
-- Аддитивно, без потери данных: пустой список = выходных нет.
ALTER TABLE "Settings" ADD COLUMN "companyDaysOff" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
ALTER TABLE "Agent" ADD COLUMN "weeklyDaysOff" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
