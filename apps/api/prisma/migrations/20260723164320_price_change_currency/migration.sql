-- AlterTable
ALTER TABLE "PriceChange" ADD COLUMN     "newCurrency" "Currency" NOT NULL DEFAULT 'TJS',
ADD COLUMN     "oldCurrency" "Currency" NOT NULL DEFAULT 'TJS';
