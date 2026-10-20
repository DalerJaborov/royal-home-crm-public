-- Счётчик просьб дать номер, который не зависит от обрезанной ленты сообщений.
-- Лента хранится обрезанной до 40 реплик, поэтому в длинном разговоре подсчёт по
-- ней терял ранние просьбы, счёт опускался ниже предела и бот принимался просить
-- номер заново. Колонка есть у ВСЕХ ТРЁХ таблиц переписок: у каждого канала своя
-- таблица и своя обрезка, значит счёт терялся в каждом.
ALTER TABLE "BotConversation" ADD COLUMN "phoneAsksSent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TelegramConversation" ADD COLUMN "phoneAsksSent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TelegramDirectConversation" ADD COLUMN "phoneAsksSent" INTEGER NOT NULL DEFAULT 0;
