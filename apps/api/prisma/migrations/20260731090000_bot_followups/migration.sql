-- Поведение бота в переписке: пауза перед ответом и напоминания молчащему клиенту.
--
-- Пауза: бот ждёт тишины (botReplyDelaySec) и продлевает ожидание, пока клиент
-- дописывает, но не дольше botReplyMaxWaitSec от первого сообщения пачки —
-- pendingSince хранит начало пачки.
--
-- Напоминания: до трёх попыток вернуть молчащего клиента в разговор, только в
-- окне followUpWindowStart..followUpWindowEnd. followUpsSent обнуляется, как
-- только клиент написал сам; optedOutAt ставится, если он попросил не писать.

ALTER TABLE "BotConversation" ADD COLUMN "pendingSince" TIMESTAMP(3);
ALTER TABLE "BotConversation" ADD COLUMN "followUpsSent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BotConversation" ADD COLUMN "optedOutAt" TIMESTAMP(3);

ALTER TABLE "Settings" ADD COLUMN "botReplyDelaySec" INTEGER NOT NULL DEFAULT 25;
ALTER TABLE "Settings" ADD COLUMN "botReplyMaxWaitSec" INTEGER NOT NULL DEFAULT 90;
ALTER TABLE "Settings" ADD COLUMN "followUpEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "followUpWindowStart" TEXT NOT NULL DEFAULT '08:00';
ALTER TABLE "Settings" ADD COLUMN "followUpWindowEnd" TEXT NOT NULL DEFAULT '20:00';
