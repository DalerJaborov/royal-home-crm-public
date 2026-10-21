ALTER TABLE "RecruitmentPosition" ADD COLUMN "screeningRules" JSONB;
ALTER TABLE "JobApplication" ADD COLUMN "recruitmentResume" JSONB;
ALTER TABLE "JobApplication" ADD COLUMN "recruitmentPhoneOverride" BOOLEAN NOT NULL DEFAULT false;
