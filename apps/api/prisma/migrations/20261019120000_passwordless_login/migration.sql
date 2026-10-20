-- Вход без пароля (владелец 19.10.2026): пароли удаляются у всех, вход по коду
-- СМС/Telegram и ключу устройства. Открытые сессии не трогаем — никого не выкидывает.
ALTER TABLE "Agent" ALTER COLUMN "passwordHash" DROP NOT NULL;
UPDATE "Agent" SET "passwordHash" = NULL, "mustChangePassword" = false;
ALTER TABLE "LoginSmsCode" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'sms';
