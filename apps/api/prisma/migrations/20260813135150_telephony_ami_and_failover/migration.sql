-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "asteriskAmiPassword" TEXT,
ADD COLUMN     "asteriskAmiPort" INTEGER NOT NULL DEFAULT 5038,
ADD COLUMN     "asteriskAmiUsername" TEXT,
ADD COLUMN     "incomingNoAnswerAction" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "incomingNoAnswerSeconds" INTEGER NOT NULL DEFAULT 20;
