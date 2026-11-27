-- Рубильник «ответ сотрудника останавливает бота» (27.11.2026), по умолчанию ВЫКЛ.
ALTER TABLE "Settings" ADD COLUMN "botPauseOnStaffReplyEnabled" BOOLEAN NOT NULL DEFAULT false;
