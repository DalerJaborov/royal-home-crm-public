-- AlterTable
-- Третий (и следующие) идентификаторы получателя, которые Meta не отдаёт ни по
-- одному полю GET /me — заполняются вручную в Настройках → Каналы, когда
-- reconcileInstagramAccountIds не может починить входящее сам (см. schema.prisma).
ALTER TABLE "MessengerAccount" ADD COLUMN     "extraExternalIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
