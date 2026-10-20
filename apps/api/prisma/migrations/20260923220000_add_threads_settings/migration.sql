-- Threads (Meta) как шестой канал автопубликации (23.09.2026) — своё приложение
-- (App ID/App Secret из use case "Threads API"), долгоживущий токен доступа и
-- профиль подключённого аккаунта. Все поля NULL по умолчанию — ничего не
-- настроено, пока владелец не введёт ключи в Настройках.
ALTER TABLE "Settings" ADD COLUMN "threadsAppId" TEXT;
ALTER TABLE "Settings" ADD COLUMN "threadsAppSecret" TEXT;
ALTER TABLE "Settings" ADD COLUMN "threadsAccessToken" TEXT;
ALTER TABLE "Settings" ADD COLUMN "threadsTokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "Settings" ADD COLUMN "threadsUserId" TEXT;
ALTER TABLE "Settings" ADD COLUMN "threadsUsername" TEXT;
ALTER TABLE "Settings" ADD COLUMN "threadsAvatarUrl" TEXT;
ALTER TABLE "Settings" ADD COLUMN "threadsConnectedAt" TIMESTAMP(3);
