-- CreateTable
CREATE TABLE "OwnerQuestion" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "clientId" TEXT,
    "propertyId" TEXT,
    "question" TEXT NOT NULL,
    "askedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answer" TEXT,
    "answeredAt" TIMESTAMP(3),
    "answeredById" TEXT,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "OwnerQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OwnerQuestion_conversationId_idx" ON "OwnerQuestion"("conversationId");

-- CreateIndex
CREATE INDEX "OwnerQuestion_answeredAt_idx" ON "OwnerQuestion"("answeredAt");

-- AddForeignKey
ALTER TABLE "OwnerQuestion" ADD CONSTRAINT "OwnerQuestion_answeredById_fkey" FOREIGN KEY ("answeredById") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

