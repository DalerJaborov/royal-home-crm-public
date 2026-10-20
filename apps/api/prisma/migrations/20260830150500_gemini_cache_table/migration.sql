-- CreateTable
CREATE TABLE "GeminiCache" (
    "hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeminiCache_pkey" PRIMARY KEY ("hash")
);

-- CreateIndex
CREATE INDEX "GeminiCache_expiresAt_idx" ON "GeminiCache"("expiresAt");

