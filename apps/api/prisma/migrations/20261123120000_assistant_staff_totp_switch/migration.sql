-- Рубильник «Код Google Authenticator для действий с сотрудниками в Telegram» (владелец 23.11.2026): по умолчанию ВЫКЛ, только новая колонка.
ALTER TABLE "Settings" ADD COLUMN "assistantStaffTotpEnabled" BOOLEAN NOT NULL DEFAULT false;
