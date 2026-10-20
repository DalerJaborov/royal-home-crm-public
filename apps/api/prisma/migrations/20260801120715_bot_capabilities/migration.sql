-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "botCanAnswerComments" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "botCanBookShowings" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "botCanConfirmShowings" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "botCanFollowUp" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "botCanSendPhotos" BOOLEAN NOT NULL DEFAULT true;
