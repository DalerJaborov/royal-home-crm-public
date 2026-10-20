-- О чём была реклама, по которой человек написал: "job" или "property".
-- Признак вакансии жил ровно один ход (referral), и со второго хода бот вёл
-- кандидата как покупателя.
ALTER TABLE "BotConversation" ADD COLUMN "adTopic" TEXT;

-- Коды публикаций вакансии (по одной в строке). Пусто — действует список по
-- умолчанию из кода, см. apps/api/src/lib/vacancyPosts.ts.
ALTER TABLE "Settings" ADD COLUMN "botVacancyPostCodes" TEXT;
