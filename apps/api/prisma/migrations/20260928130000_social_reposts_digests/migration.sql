-- Повторные показы объектов и подборки в соцсетях (28.09.2026, agent-brief.md
-- reposts-digests-28-09, решение владельца 26.09.2026).

ALTER TABLE "Settings" ADD COLUMN "repostsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "repostAfterDays" INTEGER NOT NULL DEFAULT 21;
ALTER TABLE "Settings" ADD COLUMN "repostMaxRounds" INTEGER NOT NULL DEFAULT 3;

ALTER TABLE "Settings" ADD COLUMN "digestsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "digestWeekday" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "Settings" ADD COLUMN "digestHourDushanbe" INTEGER NOT NULL DEFAULT 12;
ALTER TABLE "Settings" ADD COLUMN "digestLastRunAt" TIMESTAMP(3);

CREATE TABLE "PropertySocialRepost" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "hook" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "mediaId" TEXT,
    "secondaryId" TEXT,
    "permalink" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropertySocialRepost_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PropertySocialRepost_propertyId_round_idx" ON "PropertySocialRepost"("propertyId", "round");
CREATE INDEX "PropertySocialRepost_status_scheduledAt_idx" ON "PropertySocialRepost"("status", "scheduledAt");

ALTER TABLE "PropertySocialRepost" ADD CONSTRAINT "PropertySocialRepost_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SocialDigestPost" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "propertyIds" TEXT[],
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "mediaId" TEXT,
    "secondaryId" TEXT,
    "permalink" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialDigestPost_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SocialDigestPost_status_scheduledAt_idx" ON "SocialDigestPost"("status", "scheduledAt");
