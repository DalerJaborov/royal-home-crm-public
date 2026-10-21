ALTER TABLE "JobApplication" ADD COLUMN "hrPositionKey" TEXT;
ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_hrPositionKey_fkey"
  FOREIGN KEY ("hrPositionKey") REFERENCES "RecruitmentPosition"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
