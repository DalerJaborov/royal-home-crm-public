-- AlterTable
ALTER TABLE "JobApplication" ADD COLUMN     "city" TEXT,
ADD COLUMN     "education" TEXT,
ADD COLUMN     "eligible" BOOLEAN,
ADD COLUMN     "priority" TEXT,
ADD COLUMN     "priorityReason" TEXT,
ADD COLUMN     "studyingUniversity" BOOLEAN;
