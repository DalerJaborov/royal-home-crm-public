-- AlterTable
ALTER TABLE "Interaction" ADD COLUMN     "mentionedPhonesEncrypted" TEXT[] DEFAULT ARRAY[]::TEXT[];
