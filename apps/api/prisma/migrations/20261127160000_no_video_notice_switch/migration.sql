-- Уведомления «нет видео» у объекта (27.11.2026, владелец: «отключить совсем»). Рубильник, по умолчанию ВЫКЛ.
ALTER TABLE "Settings" ADD COLUMN "notifyNoVideoEnabled" BOOLEAN NOT NULL DEFAULT false;
