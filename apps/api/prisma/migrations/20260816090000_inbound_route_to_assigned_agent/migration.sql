-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "incomingRouteToAssignedAgent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "incomingRouteRingSeconds" INTEGER NOT NULL DEFAULT 25;

-- AlterTable
ALTER TABLE "IncomingCall" ADD COLUMN     "routeDecision" TEXT,
ADD COLUMN     "routedToId" TEXT;

-- AddForeignKey
ALTER TABLE "IncomingCall" ADD CONSTRAINT "IncomingCall_routedToId_fkey" FOREIGN KEY ("routedToId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
