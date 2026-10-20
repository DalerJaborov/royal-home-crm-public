-- CreateEnum
CREATE TYPE "WorkStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "workStatus" "WorkStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "meetingSummaryAfterShowingMinutes" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "noAnswerMaxAttempts" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "noAnswerRetryMinutes" INTEGER NOT NULL DEFAULT 15;

