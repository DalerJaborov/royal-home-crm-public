-- Ночной режим входящих: вне рабочих часов очередь пропускается,
-- звонок сразу уходит дежурному или на автоответчик.
ALTER TABLE "Settings" ADD COLUMN     "incomingNightAction" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "incomingNightStart" TEXT NOT NULL DEFAULT '21:00',
ADD COLUMN     "incomingNightEnd" TEXT NOT NULL DEFAULT '09:00';
