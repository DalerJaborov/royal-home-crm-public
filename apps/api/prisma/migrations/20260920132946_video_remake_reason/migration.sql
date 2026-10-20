-- AlterTable
ALTER TABLE "Property" ADD COLUMN     "videoHandoffLastFactsText" TEXT,
ADD COLUMN     "videoHandoffLastMessageText" TEXT,
ADD COLUMN     "videoHandoffRemakeComment" TEXT,
ADD COLUMN     "videoHandoffRemakeReason" TEXT,
ADD COLUMN     "videoRemakeCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "VideoRemakeRequest" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "comment" TEXT,
    "requestedById" TEXT NOT NULL,
    "messageText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoRemakeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VideoRemakeRequest_propertyId_idx" ON "VideoRemakeRequest"("propertyId");

-- AddForeignKey
ALTER TABLE "VideoRemakeRequest" ADD CONSTRAINT "VideoRemakeRequest_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoRemakeRequest" ADD CONSTRAINT "VideoRemakeRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
