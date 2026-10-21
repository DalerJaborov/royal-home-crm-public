CREATE TABLE "RecruitmentKeyword" (
  "word" TEXT PRIMARY KEY,
  "positionKey" TEXT NOT NULL REFERENCES "RecruitmentPosition"("key") ON DELETE CASCADE
);
CREATE INDEX "RecruitmentKeyword_positionKey_idx" ON "RecruitmentKeyword"("positionKey");
