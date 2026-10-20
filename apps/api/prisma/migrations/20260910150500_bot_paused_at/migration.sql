-- Шаг 5 переноса (10.09.2026): с какого момента НАЧАЛАСЬ текущая пауза бота.
-- pausedUntil хранит только конец паузы — списки «ждёт человека N минут» и
-- «бот на паузе больше суток» в инбоксе «Чаты» посчитать было не из чего.
ALTER TABLE "BotConversation" ADD COLUMN "botPausedAt" TIMESTAMP(3);
ALTER TABLE "TelegramConversation" ADD COLUMN "botPausedAt" TIMESTAMP(3);
