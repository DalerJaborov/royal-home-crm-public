-- Настоящий рубильник модуля Royal Score (владелец 15.09.2026): обнуление весов
-- KPI и отключение пушей не останавливало ни начисления, ни журнал, ни карточку
-- в профиле. default true — поведение на проде не меняется само в момент выката.
ALTER TABLE "Settings" ADD COLUMN "royalScoreEnabled" BOOLEAN NOT NULL DEFAULT true;
