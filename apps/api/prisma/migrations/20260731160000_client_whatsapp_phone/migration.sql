-- Номер WhatsApp клиента (wa_id из вебхука Meta), подставляемый в карточку
-- автоматически. Отдельно от Client.phone и БЕЗ уникальности: приём входящего
-- сообщения не должен падать на конфликте дублей.
ALTER TABLE "Client" ADD COLUMN "whatsappPhone" TEXT;

CREATE INDEX "Client_whatsappPhone_idx" ON "Client"("whatsappPhone");
