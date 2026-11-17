CREATE TABLE "SomonPhoneSighting" (
  "phoneHash" TEXT NOT NULL,
  "advertId" TEXT NOT NULL,
  "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SomonPhoneSighting_pkey" PRIMARY KEY ("phoneHash", "advertId")
);
CREATE INDEX "SomonPhoneSighting_seenAt_idx" ON "SomonPhoneSighting"("seenAt");
