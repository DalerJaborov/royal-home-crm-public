-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "sipExtension" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Agent_sipExtension_key" ON "Agent"("sipExtension");

