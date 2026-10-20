-- 17.09.2026, решение владельца (docs/match-policy-plan-17-09.md): единая политика
-- подбора вместо чисел, зашитых по коду в трёх местах. Умолчания = сегодняшние
-- зашитые значения, чтобы включение колонок ничего не сдвинуло молча.

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "autoMatchEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "matchIncludeInactive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "matchIncludeDeferred" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "matchNotifyPropertyOwner" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "matchRequirementTtlDays" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "Settings" ADD COLUMN "matchPriceDropRenotifyPct" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "Settings" ADD COLUMN "matchBudgetTolerancePct" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "Settings" ADD COLUMN "matchAreaTolerancePct" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "Settings" ADD COLUMN "matchRoomsTolerance" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Settings" ADD COLUMN "matchDefaultRadiusM" INTEGER NOT NULL DEFAULT 1500;
ALTER TABLE "Settings" ADD COLUMN "matchRadiusMaxMultiplier" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "Settings" ADD COLUMN "matchMinCandidates" INTEGER NOT NULL DEFAULT 3;
