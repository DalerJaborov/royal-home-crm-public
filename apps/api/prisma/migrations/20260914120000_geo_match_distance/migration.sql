-- 12.09.2026, docs/geo-match-plan-12-09.md, блок D: расстояние в автоподборе.
--
-- Два независимых изменения одной миграцией (одна задача, один PR):
--
-- 1. Индекс на Property(lat, lng) — bbox-предфильтр гео-подбора (D2) читает
--    объекты по координатам на каждый вызов подбора; без индекса это полный
--    перебор таблицы объектов. Тот же вид индекса, что уже стоит на
--    ClientDesiredPlace(lat, lng) (миграция 20260912120000_client_desired_place).
--
-- 2. Settings.matchScoreDistance — ОТДЕЛЬНЫЙ вес шкалы совпадения для расстояния
--    (D3). matchScoreDistrict НЕ трогаем: если начислять баллы за район по
--    расстоянию, порог ownPropertyMatchThreshold=90 начал бы уводить лиды между
--    районами, а matching-score.test.ts (баллы прибиты явно) покраснел бы без
--    единой смысловой причины. Изменение аддитивное — старые интеграции,
--    читающие Settings до этой колонки, получают COALESCE-совместимое умолчание.

-- CreateIndex
CREATE INDEX "Property_lat_lng_idx" ON "Property"("lat", "lng");

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "matchScoreDistance" INTEGER NOT NULL DEFAULT 25;
