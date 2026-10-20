-- «Ждёт варианты»/«Ждёт показ»: через сколько минут напомнить и сколько раз,
-- прежде чем заблокировать выдачу новых лидов агенту.
ALTER TABLE "Settings" ADD COLUMN "waitingCheckAfterMinutes" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "Settings" ADD COLUMN "waitingCheckMaxRepeats" INTEGER NOT NULL DEFAULT 2;
