-- CreateEnum
CREATE TYPE "ClientInactiveLevel" AS ENUM ('GREEN', 'YELLOW', 'RED');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "inactiveLevel" "ClientInactiveLevel",
ADD COLUMN     "inactivePingCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "inactiveReasonKey" TEXT,
ADD COLUMN     "inactiveSince" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "agentOccupancyShieldAfterMinutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "agentOccupancyShieldEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "buyerThinkingFirstPingHours" INTEGER NOT NULL DEFAULT 48,
ADD COLUMN     "buyerThinkingSecondPingHours" INTEGER NOT NULL DEFAULT 72,
ADD COLUMN     "buyerThinkingSlowTrackDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "inactivateCooldownHours" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "inactivateMinAttempts" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "inactiveGreenMaxAttempts" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "inactiveGreenPingHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "inactiveRedMaxAttempts" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "inactiveRedPingHours" INTEGER NOT NULL DEFAULT 72,
ADD COLUMN     "inactiveYellowMaxAttempts" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "inactiveYellowPingHours" INTEGER NOT NULL DEFAULT 48,
ADD COLUMN     "leadPoolAfterMinutes" INTEGER NOT NULL DEFAULT 25,
ADD COLUMN     "lostReturnAcceptMinutes" INTEGER NOT NULL DEFAULT 120,
ADD COLUMN     "sellerPropertyMissingCriticalDays" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "sellerPropertyMissingWarnDays" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "transferQuotaPerMonth" INTEGER NOT NULL DEFAULT 3;

-- CreateIndex
CREATE INDEX "Client_workStatus_inactiveLevel_inactiveSince_idx" ON "Client"("workStatus", "inactiveLevel", "inactiveSince");

-- Лестница вместо кирпича (владелец 21.08.2026, рекомендация «CRM вместо РОПа»):
-- окно-баннер до сегодняшнего дня было тихо отключено на фронте (см. коммит фикса
-- PendingSummaryBanner в этой же партии) — жёсткая блокировка всей CRM всё это
-- время фактически не работала. Возвращаем баннер видимым, но НЕ включаем вместе
-- с ним старую жёсткую блокировку заново — переключатель остаётся в Настройках
-- (DisciplineTab.tsx), владелец может включить в любой момент сам, без кода.
UPDATE "Settings" SET "summaryHardBlockEnabled" = false WHERE id = 'singleton';
