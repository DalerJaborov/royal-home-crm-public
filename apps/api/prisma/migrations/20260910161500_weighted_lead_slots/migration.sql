-- «Взвешенные слоты» лимита лидов (мозговой штурм владельца 20-21.08.2026,
-- «Логика 2.0»: свежий 1.0 / после показа 0.5 / думает 0.25).
--
-- Рубильник выключен по умолчанию: правило меняет раздачу лидов всей компании,
-- и включает его владелец в Настройках, а не миграция. Веса — в процентах
-- слота, чтобы жить целым числом и правиться без выката.
ALTER TABLE "Settings" ADD COLUMN "weightedLeadSlotsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "leadSlotWeightFreshPercent" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "Settings" ADD COLUMN "leadSlotWeightAfterShowingPercent" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "Settings" ADD COLUMN "leadSlotWeightThinkingPercent" INTEGER NOT NULL DEFAULT 25;
