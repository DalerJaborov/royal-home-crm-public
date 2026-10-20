-- Секрет приложения Meta на уровне аккаунта: без него второй аккаунт, живущий под
-- другим App ID, получал 403 на весь вебхук ещё до разбора тела.
-- AlterTable
ALTER TABLE "MessengerAccount" ADD COLUMN "appSecret" TEXT;
