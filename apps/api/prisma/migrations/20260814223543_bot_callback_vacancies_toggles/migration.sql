-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "botCanHandleVacancies" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "botCanRequestCallback" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "botCanSendLinks" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "botCautiousMode" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CallbackRequest" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT,
    "clientId" TEXT,
    "channel" TEXT NOT NULL,
    "phone" TEXT,
    "topic" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" TIMESTAMP(3),
    "doneById" TEXT,

    CONSTRAINT "CallbackRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobApplication" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT,
    "channel" TEXT NOT NULL,
    "contactName" TEXT,
    "name" TEXT,
    "age" INTEGER,
    "experience" TEXT,
    "hasCar" BOOLEAN,
    "languages" TEXT,
    "startWhen" TEXT,
    "phone" TEXT,
    "rawText" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CallbackRequest_doneAt_requestedAt_idx" ON "CallbackRequest"("doneAt", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobApplication_conversationId_key" ON "JobApplication"("conversationId");

-- CreateIndex
CREATE INDEX "JobApplication_status_createdAt_idx" ON "JobApplication"("status", "createdAt");
