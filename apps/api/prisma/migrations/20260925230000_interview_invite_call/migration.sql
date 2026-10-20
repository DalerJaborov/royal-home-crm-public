-- Робот приглашает кандидата на собеседование (25.09.2026).
ALTER TABLE "Settings" ADD COLUMN "interviewInviteAddress" TEXT;

CREATE TABLE "InterviewInviteCall" (
    "id" TEXT NOT NULL,
    "jobApplicationId" TEXT NOT NULL,
    "interviewAt" TIMESTAMP(3) NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'ru',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "channelId" TEXT,
    "talkedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "proposedTime" TEXT,
    "quote" TEXT,
    "summary" TEXT,
    "skipReason" TEXT,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterviewInviteCall_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InterviewInviteCall_status_scheduledFor_idx" ON "InterviewInviteCall"("status", "scheduledFor");
CREATE INDEX "InterviewInviteCall_jobApplicationId_createdAt_idx" ON "InterviewInviteCall"("jobApplicationId", "createdAt");
CREATE INDEX "InterviewInviteCall_channelId_idx" ON "InterviewInviteCall"("channelId");

ALTER TABLE "InterviewInviteCall" ADD CONSTRAINT "InterviewInviteCall_jobApplicationId_fkey" FOREIGN KEY ("jobApplicationId") REFERENCES "JobApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
