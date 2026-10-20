-- CreateTable
CREATE TABLE "VideoOpening" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "videoPath" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "firstShot" TEXT,
    "hasPerson" BOOLEAN NOT NULL DEFAULT false,
    "hasText" BOOLEAN NOT NULL DEFAULT false,
    "hookScore" INTEGER,
    "note" TEXT,
    "tip" TEXT,
    "durationSec" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoOpening_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VideoOpening_propertyId_videoPath_key" ON "VideoOpening"("propertyId", "videoPath");

-- AddForeignKey
ALTER TABLE "VideoOpening" ADD CONSTRAINT "VideoOpening_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;
