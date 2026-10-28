ALTER TABLE "SomonSeenAdvert" ADD COLUMN "sellerCheck" JSONB, ADD COLUMN "lastCheckedAt" TIMESTAMP(3);
UPDATE "SomonSeenAdvert" SET "lastCheckedAt" = "seenAt" WHERE "status" = 'PENDING';
