-- Вероятность закрытия по стадии сделки — веса прогноза денег к концу месяца.
-- Значения по умолчанию живут в коде (@royal-home/shared,
-- DEAL_STAGE_WIN_PROBABILITY_DEFAULT), поэтому колонка nullable без DEFAULT:
-- NULL здесь означает «владелец веса не трогал», а не «весов нет».
ALTER TABLE "Settings" ADD COLUMN "dealStageWinProbability" JSONB;
