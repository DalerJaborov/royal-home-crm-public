-- Резерв объекта на сделке: с какого момента считается таймер 3 рабочих дня.
ALTER TABLE "Property" ADD COLUMN "reservedAt" TIMESTAMP(3);

-- Сколько рабочих дней держим объект в резерве, прежде чем вернуть в продажу.
ALTER TABLE "Settings" ADD COLUMN "dealReservationBusinessDays" INTEGER NOT NULL DEFAULT 3;
