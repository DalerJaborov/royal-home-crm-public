-- Раздельные рубильники бота по каналам.
--
-- До сих пор рубильник был один на всё (botEnabled) плюс общий рубильник
-- транспорта Meta (metaEnabled) сразу на три канала. Из-за этого нельзя было
-- унять бота в Instagram, не выключив заодно WhatsApp, где всё в порядке.
--
-- Эти поля отвечают ТОЛЬКО на вопрос «говорит ли бот в этом канале». Подключён
-- ли канал вообще — по-прежнему metaEnabled и наличие ключей: выключенный
-- рубильник бота НЕ мешает входящим попадать в переписку CRM, сотрудник
-- отвечает вручную.
--
-- Значение по умолчанию true: до этой миграции бот отвечал во всех каналах, и
-- выкатка не должна менять поведение ни на одном из них.

ALTER TABLE "Settings" ADD COLUMN "botWhatsappEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "botInstagramEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "botFacebookEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "botTelegramEnabled" BOOLEAN NOT NULL DEFAULT true;
