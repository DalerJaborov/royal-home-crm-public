-- Лишние уведомления агентам (27.11.2026, владелец: «Все пять групп»). Не удаляем — рубильник, по умолчанию тихо.
-- Только добавляют колонки; переключает человек в Настройках → «Уведомления».
ALTER TABLE "Settings" ADD COLUMN "notifyRepeatContactPushEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "notifyMarketMatchPushEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "notifyDealClosedTeamPushEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "notifyOperatorTalkedPushEnabled" BOOLEAN NOT NULL DEFAULT false;
