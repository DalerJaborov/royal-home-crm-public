-- Контроль заполнения карточки клиента (решение владельца 30.07): напоминание
-- агенту через час, сообщение руководству через 12 часов, кнопка «Я в работе»
-- перезапускает отсчёт.
ALTER TABLE "Client" ADD COLUMN "cardReminderSentAt" TIMESTAMP(3);
ALTER TABLE "Client" ADD COLUMN "cardEscalatedAt" TIMESTAMP(3);
ALTER TABLE "Client" ADD COLUMN "workingMarkedAt" TIMESTAMP(3);
