-- Доставка исходников монтажёру отдельно от занятия места (объект №121, 22.09.2026).
ALTER TABLE "Property" ADD COLUMN "videoHandoffDeliveredAt" TIMESTAMP(3);
ALTER TABLE "Property" ADD COLUMN "videoHandoffDispatchAttempts" INTEGER NOT NULL DEFAULT 0;
-- Закрытые передачи считаем доставленными. Висящие SENT_TO_EDITOR оставляем null
-- намеренно: доставка у них не подтверждена, сторож дошлёт.
UPDATE "Property" SET "videoHandoffDeliveredAt" = "videoHandoffSentAt" WHERE "videoHandoffStatus" = 'RECEIVED';
