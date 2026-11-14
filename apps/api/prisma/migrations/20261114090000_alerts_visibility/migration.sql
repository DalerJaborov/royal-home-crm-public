-- Срочные тревоги руководству идут мимо часов алармов; колокольчик пишется сразу (аудит 14.11.2026, №1).
ALTER TABLE "PendingDirectorAlert" ADD COLUMN "urgent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PendingDirectorAlert" ADD COLUMN "feedAt" TIMESTAMP(3);
-- Сторож «клиент написал, ему не ответили»: одна тревога на эпизод молчания.
ALTER TABLE "BotConversation" ADD COLUMN "silenceAlertFor" TIMESTAMP(3);
