-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "inactivityPenaltyAfterDays" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "inactivityPenaltyPoints" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "inactivityWarnAfterDays" INTEGER NOT NULL DEFAULT 3;

