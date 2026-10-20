-- Воронка найма: 4 статуса -> 6, плюс поля собеседования/отказа/найма.

ALTER TABLE "JobApplication" ADD COLUMN "interviewAt" TIMESTAMP(3);
ALTER TABLE "JobApplication" ADD COLUMN "interviewNote" TEXT;
ALTER TABLE "JobApplication" ADD COLUMN "rejectionReason" TEXT;
ALTER TABLE "JobApplication" ADD COLUMN "hiredAt" TIMESTAMP(3);
ALTER TABLE "JobApplication" ADD COLUMN "talentPool" BOOLEAN NOT NULL DEFAULT false;

-- INVITED переименован в INTERVIEW (тот же смысл: «позвали на собеседование»),
-- чтобы влезть в общий линейный порядок стадий вместе с новыми INTERVIEWED/HIRED.
UPDATE "JobApplication" SET "status" = 'INTERVIEW' WHERE "status" = 'INVITED';
