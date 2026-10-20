-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "ownerQuestionAutoReplyHours" INTEGER NOT NULL DEFAULT 6;

-- AlterTable
ALTER TABLE "OwnerQuestion" ADD COLUMN     "autoRepliedAt" TIMESTAMP(3);
