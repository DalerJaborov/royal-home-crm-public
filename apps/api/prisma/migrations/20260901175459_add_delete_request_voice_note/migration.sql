-- AlterTable
ALTER TABLE "ClientDeleteRequest" ADD COLUMN     "commentVoiceTranscript" TEXT,
ADD COLUMN     "commentVoiceUrl" TEXT;

-- AlterTable
ALTER TABLE "PropertyDeleteRequest" ADD COLUMN     "commentVoiceTranscript" TEXT,
ADD COLUMN     "commentVoiceUrl" TEXT;
