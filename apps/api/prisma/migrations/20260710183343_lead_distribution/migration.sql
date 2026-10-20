-- AlterEnum
ALTER TYPE "ClientSource" ADD VALUE 'TELEGRAM';

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "acceptedAt" TIMESTAMP(3),
ADD COLUMN     "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: все существующие клиенты считаются уже принятыми своими агентами,
-- иначе после деплоя у агентов разом скрылись бы телефоны всей текущей базы.
UPDATE "Client" SET "acceptedAt" = "createdAt", "assignedAt" = "createdAt";

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "leadAcceptMinutes" INTEGER NOT NULL DEFAULT 15;

-- CreateIndex
CREATE INDEX "Client_acceptedAt_idx" ON "Client"("acceptedAt");
