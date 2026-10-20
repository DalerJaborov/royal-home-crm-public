-- Звонок-приглашение кандидату: набранный номер, возврат после нашего сбоя, запись разговора.
ALTER TABLE "InterviewInviteCall" ADD COLUMN "phone" TEXT;
ALTER TABLE "InterviewInviteCall" ADD COLUMN "failureRetries" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "InterviewInviteCall" ADD COLUMN "recordingKey" TEXT;
