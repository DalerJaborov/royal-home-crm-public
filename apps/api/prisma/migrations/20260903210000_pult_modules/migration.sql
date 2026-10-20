-- CreateTable
CREATE TABLE "PultModule" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "PultModule_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "CronHeartbeat" ADD COLUMN     "lastSkippedAt" TIMESTAMP(3),
ADD COLUMN     "lastSkipReason" TEXT;
