-- AlterTable
ALTER TABLE "PropertyVideo" ADD COLUMN     "durationSec" DOUBLE PRECISION,
ADD COLUMN     "hasAudio" BOOLEAN,
ADD COLUMN     "height" INTEGER,
ADD COLUMN     "videoCodec" TEXT,
ADD COLUMN     "width" INTEGER;
