-- AlterTable
ALTER TABLE "Interaction" ADD COLUMN     "continuesInteractionId" TEXT;

-- CreateIndex
CREATE INDEX "Interaction_continuesInteractionId_idx" ON "Interaction"("continuesInteractionId");

-- AddForeignKey
ALTER TABLE "Interaction" ADD CONSTRAINT "Interaction_continuesInteractionId_fkey" FOREIGN KEY ("continuesInteractionId") REFERENCES "Interaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
