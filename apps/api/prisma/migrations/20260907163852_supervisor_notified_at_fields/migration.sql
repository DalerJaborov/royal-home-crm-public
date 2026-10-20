-- AlterTable
ALTER TABLE "Interaction" ADD COLUMN     "supervisorNotifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PendingSummary" ADD COLUMN     "supervisorNotifiedAt" TIMESTAMP(3);
