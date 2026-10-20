-- «Застой сделки»: продавец без объекта / покупатель без сделки дольше N дней.
-- AlterTable
ALTER TABLE "Client" ADD COLUMN "dealStaleEscalatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "dealStaleSellerDays" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "Settings" ADD COLUMN "dealStaleBuyerDays" INTEGER NOT NULL DEFAULT 21;
