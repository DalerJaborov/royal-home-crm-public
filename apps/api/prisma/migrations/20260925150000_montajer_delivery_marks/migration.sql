-- Отметка «этот исходник дошёл до монтажёра в текущем круге» (25.09.2026).
-- AlterTable
ALTER TABLE "PropertyVideo" ADD COLUMN     "montajerDeliveredAt" TIMESTAMP(3),
ADD COLUMN     "montajerDeliveredToId" TEXT;
