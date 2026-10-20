-- Public recruitment facts, separate from private candidate applications.
-- No assumption that an old advertising link proves an opening is current.
CREATE TABLE "RecruitmentPosition" (
  "key" TEXT PRIMARY KEY,
  "titleRu" TEXT NOT NULL,
  "titleTg" TEXT NOT NULL,
  "detailsRu" TEXT NOT NULL DEFAULT '',
  "detailsTg" TEXT NOT NULL DEFAULT '',
  "isOpen" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "RecruitmentPublication" (
  "code" TEXT PRIMARY KEY,
  "positionKey" TEXT NOT NULL REFERENCES "RecruitmentPosition"("key") ON DELETE CASCADE
);
CREATE INDEX "RecruitmentPublication_positionKey_idx" ON "RecruitmentPublication"("positionKey");
